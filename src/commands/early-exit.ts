import {
  buildAnnounceL1EarlyExit,
  buildLockOutputScript,
  buildLockScript,
  buildUnlockScript,
  computeBondUnlockHeight,
  computeRegisterPreimage,
  fetchBondMembership,
  fetchConstructLockupOutputScript,
  fetchHasAnnouncedL1EarlyExit,
  fetchPoxInfo,
  fetchProtocolBond,
} from '@stacks/bitcoin-staking';
import { bytesToHex } from '@stacks/common';
import * as btc from '@scure/btc-signer';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import {
  broadcastBtcTx,
  btcNetwork,
  buildEarlyExitSpend,
  fetchBtcTxHex,
  parseSingleKeyEarlyUnlock,
  parseTxOutput,
  resolveBtcKey,
  type BtcNetworkName,
} from '../btc.js';
import { bitcoinAddressLink, bitcoinTxLink, explorerLink, explorerTxLink } from '../explorer.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { signAndConfirm, txStatusLabel, type TxOutcome } from '../tx.js';
import { output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const DUST_SATS = 546n;

export interface UtxoRef {
  txid: string;
  vout: number;
}

export interface EarlyExitOpts {
  bond: number;
  utxo?: UtxoRef;
  to?: string;
  btcFee: bigint;
  btcNetwork: BtcNetworkName;
  signerManager?: string;
  fee: bigint;
  announce: boolean;
  broadcast: boolean;
}

export async function earlyExitCommand(ctx: Ctx, opts: EarlyExitOpts): Promise<void> {
  if (!opts.utxo && !opts.announce) {
    throw new CliError('nothing to do — give --utxo to spend the L1 lock, or drop --no-announce to announce on L2');
  }

  const privateKey = resolveStxPrivateKey();
  const staker = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const [bond, poxRaw, membership] = await Promise.all([
    fetchProtocolBond({ bondIndex: opts.bond, ...ctx.net }),
    fetchPoxInfo(ctx.net),
    fetchBondMembership({ address: staker, ...ctx.net }),
  ]);
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const signerManager = opts.signerManager ?? membership?.signer ?? `${staker}.signer-manager`;

  // --- L1: spend the lock via the early-exit (OP_ELSE) branch ---
  let l1:
    | { lockAddress: string; lockSats: bigint; outputSats: bigint; to: string; txid: string; txHex: string }
    | undefined;
  if (opts.utxo) {
    const net = btcNetwork(opts.btcNetwork);
    const key = resolveBtcKey(net);
    const to = opts.to ?? key.address;

    const single = parseSingleKeyEarlyUnlock(bond.earlyUnlockBytes);
    if (!single) {
      throw new CliError(
        `bond ${opts.bond}'s early-unlock-bytes is not the single-key form (21<pubkey>ac|ad) — ` +
          'the CLI can only assemble the early-exit witness for a single-key early-unlock fragment',
      );
    }
    if (single.publicKey !== key.publicKey) {
      throw new CliError(
        `bond ${opts.bond}'s early-unlock key (${single.publicKey}) is not POX5_BTC_WIF (${key.publicKey}) — ` +
          'only the early-unlock signer can authorize the early-exit branch, so this lock cannot be self-exited',
      );
    }

    const unlockHeight = computeBondUnlockHeight({ bondIndex: opts.bond, poxInfo: pox });
    const stakerUnlockBytes = buildUnlockScript(key.publicKey);
    const witnessScript = buildLockScript({
      stxAddress: staker,
      unlockHeight,
      unlockBytes: stakerUnlockBytes,
      earlyUnlockBytes: bond.earlyUnlockBytes,
    });
    const lockOutputScript = buildLockOutputScript({
      stxAddress: staker,
      unlockHeight,
      unlockBytes: stakerUnlockBytes,
      earlyUnlockBytes: bond.earlyUnlockBytes,
    });
    const onChain = bytesToHex(
      await fetchConstructLockupOutputScript({
        stxAddress: staker,
        unlockHeight,
        unlockBytes: stakerUnlockBytes,
        earlyUnlockBytes: bond.earlyUnlockBytes,
        ...ctx.net,
      }),
    );
    if (onChain !== bytesToHex(lockOutputScript)) {
      throw new CliError(
        "locally derived lockup script does not match the contract's construct-lockup-output-script — " +
          'refusing to build a spend that would not match the lock (the script template likely changed)',
      );
    }

    const lockTxHex = await fetchBtcTxHex(ctx.config, opts.utxo.txid);
    const lockOut = parseTxOutput(lockTxHex, opts.utxo.vout);
    if (bytesToHex(lockOut.script) !== bytesToHex(lockOutputScript)) {
      throw new CliError(
        `utxo ${opts.utxo.txid}:${opts.utxo.vout} does not pay this bond's lock address — ` +
          'pass the output of the lock-btc transaction for this bond and staker',
      );
    }
    if (lockOut.amount - opts.btcFee <= DUST_SATS) {
      throw new CliError(`lock holds ${lockOut.amount} sats — too little to cover the ${opts.btcFee} sats fee above dust`);
    }

    const lockAddress = btc.Address(net).encode({ type: 'wsh', hash: lockOutputScript.slice(2) });
    const spend = buildEarlyExitSpend({
      lockTxid: opts.utxo.txid,
      lockVout: opts.utxo.vout,
      lockAmount: lockOut.amount,
      lockScriptPubKey: lockOut.script,
      witnessScript,
      preimage: computeRegisterPreimage(staker),
      needsFiller: single.needsFiller,
      privateKey: key.privateKey,
      to,
      feeSats: opts.btcFee,
      network: net,
    });
    l1 = { lockAddress, lockSats: lockOut.amount, outputSats: spend.outputSats, to, txid: spend.txid, txHex: spend.txHex };
  }

  // --- L2: announce-l1-early-exit ---
  let l2: { tx: Awaited<ReturnType<typeof buildAnnounceL1EarlyExit>>; nonce: bigint; blockers: string[] } | undefined;
  if (opts.announce) {
    const [nonce, alreadyAnnounced] = await Promise.all([
      fetchNonce({ address: staker, ...ctx.net }),
      fetchHasAnnouncedL1EarlyExit({ bondIndex: opts.bond, staker, ...ctx.net }),
    ]);
    const blockers: string[] = [];
    if (membership === undefined) {
      blockers.push(`${staker} has no active bond membership (ERR_NOT_BOND_PARTICIPANT u34)`);
    } else {
      if (!membership.isL1Lock) blockers.push('membership is sBTC-backed, not an L1 lock — use unstake-sbtc (ERR_CANNOT_ANNOUNCE_L1_EARLY_UNLOCK u35)');
      if (membership.bondIndex !== opts.bond) blockers.push(`active membership is bond ${membership.bondIndex}, not ${opts.bond}`);
      if (membership.signer !== signerManager) blockers.push(`signer-manager ${signerManager} does not match the membership signer ${membership.signer} (ERR_INVALID_OLD_SIGNER_MANAGER u36)`);
    }
    if (alreadyAnnounced) blockers.push(`early exit already announced for bond ${opts.bond} (ERR_L1_EARLY_EXIT_ALREADY_ANNOUNCED u50)`);

    const tx = await buildAnnounceL1EarlyExit({
      staker,
      oldSignerManager: signerManager,
      publicKey,
      fee: opts.fee,
      nonce,
      network: ctx.net.network,
    });
    l2 = { tx, nonce, blockers };
  }

  const l1Rows: Row[] = l1
    ? [
        ['lock address', bitcoinAddressLink(ctx.config, l1.lockAddress)],
        ['lock amount', sats(l1.lockSats)],
        ['recover to', bitcoinAddressLink(ctx.config, l1.to)],
        ['recovered', `${sats(l1.outputSats)} (fee ${opts.btcFee} sats)`],
        ['spend txid', l1.txid],
      ]
    : [];

  const json = {
    staker,
    bondIndex: opts.bond,
    signerManager,
    l1Spend: l1 ? { lockAddress: l1.lockAddress, lockSats: l1.lockSats, recoverTo: l1.to, outputSats: l1.outputSats, feeSats: opts.btcFee, txid: l1.txid, txHex: l1.txHex } : null,
    announce: l2 ? { nonce: l2.nonce, fee: opts.fee, blockers: l2.blockers } : null,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Early exit — bond ${opts.bond} (dry run)`);
      printRows([['staker', explorerLink(ctx.config, staker)], ['signer-manager', explorerLink(ctx.config, signerManager)]]);
      if (l1) {
        printSection('L1 spend (Bitcoin early-exit branch)');
        printRows(l1Rows);
      }
      if (l2) {
        printSection('L2 announce (announce-l1-early-exit)');
        printRows([['fee', stx(opts.fee)], ['nonce', l2.nonce]]);
        for (const b of l2.blockers) printNote(b);
      }
      printNote('re-run with --broadcast to send' + (l1 ? ' the Bitcoin spend' : '') + (l1 && l2 ? ' and' : '') + (l2 ? ' the L2 announce' : ''));
    });
    return;
  }

  if (l2 && l2.blockers.length > 0) {
    throw new CliError(`L2 announce would be rejected: ${l2.blockers.join('; ')}`);
  }

  let l1Txid: string | undefined;
  if (l1) l1Txid = await broadcastBtcTx(ctx.config, l1.txHex);

  let announceTxid: string | undefined;
  let announceOutcome: TxOutcome | undefined;
  if (l2) {
    const r = await signAndConfirm(ctx, l2.tx, privateKey);
    announceTxid = r.txid;
    announceOutcome = r.outcome;
  }

  output(ctx, { ...json, l1Txid: l1Txid ?? null, announceTxid: announceTxid ?? null, announceStatus: announceOutcome?.status ?? null }, () => {
    printSection(`Early exit — bond ${opts.bond}`);
    printRows([['staker', explorerLink(ctx.config, staker)], ['signer-manager', explorerLink(ctx.config, signerManager)]]);
    if (l1 && l1Txid) {
      printSection('L1 spend (Bitcoin early-exit branch)');
      printRows([...l1Rows.slice(0, -1), ['spend txid', bitcoinTxLink(ctx.config, l1Txid)]]);
    }
    if (announceTxid && announceOutcome) {
      printSection('L2 announce (announce-l1-early-exit)');
      printRows([['txid', explorerTxLink(ctx.config, announceTxid)], ['result', txStatusLabel(announceOutcome)]]);
      if (announceOutcome.aborted) printNote('the L2 announce reverted on-chain — the early exit was not recorded');
      else if (announceOutcome.pending) printNote('still pending — re-check the explorer link');
      else printNote('BTC shares are wound down; the paired STX stays locked through the bond’s normal unlock cycle');
    }
  });
  if (announceOutcome?.aborted) process.exitCode = 1;
}
