import {
  buildAnnounceL1EarlyExit,
  buildReclaim,
  buildRegisterMetadata,
  fetchEligibleAnnounceL1EarlyExit,
  fetchBondMembership,
  fetchConstructLockupOutputScript,
  fetchPoxInfo,
  fetchProtocolBond,
  finalizeReclaim,
} from '@stacks/bitcoin-staking';
import { bytesToHex } from '@stacks/common';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError, eligibilityBlockers } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import {
  broadcastBtcTx,
  btcNetwork,
  fetchBtcTxHex,
  parseTxOutput,
  resolveBtcKey,
  stacksNetworkForBtc,
  type BtcNetworkName,
} from '../btc.js';
import { bitcoinAddressLink, bitcoinTxLink, explorerLink, explorerTxLink } from '../explorer.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { signAndConfirm, txStatusLabel, type TxOutcome } from '../tx.js';
import { output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

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

    const metadata = buildRegisterMetadata({
      bondIndex: opts.bond,
      poxInfo: pox,
      bitcoinPublicKey: key.publicKey,
      stxAddress: staker,
      earlyUnlockBytes: bond.earlyUnlockBytes,
      network: stacksNetworkForBtc(opts.btcNetwork),
    });
    const {
      unlockHeight,
      unlockBytes: stakerUnlockBytes,
      lockScript: witnessScript,
      outputScript: lockOutputScript,
      lockAddress,
    } = metadata;
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
    let spend: ReturnType<typeof finalizeReclaim>;
    try {
      const reclaim = buildReclaim({
        path: 'early-exit',
        utxo: { txid: opts.utxo.txid, vout: opts.utxo.vout, value: lockOut.amount, scriptPubKey: lockOut.script },
        network: stacksNetworkForBtc(opts.btcNetwork),
        output: { address: to, feeSats: opts.btcFee },
        lockScript: witnessScript,
      });
      reclaim.signIdx(key.privateKey, 0);
      spend = finalizeReclaim({ path: 'early-exit', tx: reclaim, stxAddress: staker });
    } catch (e) {
      throw new CliError(
        `could not build the early-exit reclaim: ${(e as Error).message}. ` +
          'POX5_BTC_WIF must authorize both the staker and early-exit signature slots for a self-exit',
      );
    }
    l1 = {
      lockAddress,
      lockSats: lockOut.amount,
      outputSats: lockOut.amount - opts.btcFee,
      to,
      txid: spend.txid,
      txHex: spend.txHex,
    };
  }

  // --- L2: announce-l1-early-exit ---
  let l2: { tx: Awaited<ReturnType<typeof buildAnnounceL1EarlyExit>>; nonce: bigint; blockers: string[] } | undefined;
  if (opts.announce) {
    const [nonce, eligibility] = await Promise.all([
      fetchNonce({ address: staker, ...ctx.net }),
      fetchEligibleAnnounceL1EarlyExit({
        staker,
        oldSignerManager: signerManager,
        poxInfo: pox,
        ...ctx.net,
      }),
    ]);
    const blockers = eligibilityBlockers(eligibility);
    if (membership !== undefined && membership.bondIndex !== opts.bond) {
      blockers.push(`active membership is bond ${membership.bondIndex}, not ${opts.bond}`);
    }

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
