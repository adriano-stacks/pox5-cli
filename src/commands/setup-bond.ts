import {
  BOND_END_OFFSET_PERIODS,
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  bondPhaseRanges,
  buildSetupBond,
  buildUnlockScript,
  fetchBondAdmin,
  fetchEligibleSetupBond,
  fetchPoxInfo,
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
import { resolveBondAdminPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { bps, dim, output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

export interface AllowEntry {
  staker: string;
  maxSats: bigint;
}

export interface SetupBondOpts {
  bondIndex: number;
  targetRateBps: number;
  stxValueRatio: bigint;
  minUstxRatioBps: number;
  earlyUnlockBytesHex?: string;
  allowlist: AllowEntry[];
  fee: bigint;
  broadcast: boolean;
}

function compressedPublicKey(privateKey: string): string {
  const key = privateKey.length === 64 ? privateKey + '01' : privateKey;
  return publicKeyToHex(privateKeyToPublic(key));
}

export async function setupBondCommand(ctx: Ctx, opts: SetupBondOpts): Promise<void> {
  const privateKey = resolveBondAdminPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const earlyUnlockDefaulted = opts.earlyUnlockBytesHex === undefined;
  const earlyUnlockBytesHex =
    opts.earlyUnlockBytesHex ?? bytesToHex(buildUnlockScript(compressedPublicKey(privateKey)));

  const poxRaw = await fetchPoxInfo(ctx.net);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bondIndex, poxInfo: pox });
  const firstRewardCycle = bondPeriodToRewardCycle({ bondIndex: opts.bondIndex, poxInfo: pox });
  const unlockCycle = bondPeriodToRewardCycle({
    bondIndex: opts.bondIndex + BOND_END_OFFSET_PERIODS,
    poxInfo: pox,
  });
  const windowOpenHeight = bondPhaseRanges({ bondIndex: opts.bondIndex, poxInfo: pox })[0]!.startBurnHeight;

  const totalAllowSats = opts.allowlist.reduce((sum, e) => sum + e.maxSats, 0n);
  const [bondAdmin, nonce, eligibility] = await Promise.all([
    fetchBondAdmin(ctx.net),
    fetchNonce({ address: sender, ...ctx.net }),
    fetchEligibleSetupBond({
      bondIndex: opts.bondIndex,
      allowlist: opts.allowlist,
      caller: sender,
      poxInfo: pox,
      ...ctx.net,
    }),
  ]);
  const blockers = eligibilityBlockers(eligibility);

  const tx = await buildSetupBond({
    bondIndex: opts.bondIndex,
    targetRateBps: opts.targetRateBps,
    stxValueRatio: opts.stxValueRatio,
    minUstxRatioBps: opts.minUstxRatioBps,
    earlyUnlockBytes: earlyUnlockBytesHex,
    allowlist: opts.allowlist,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });

  const baseRows: Row[] = [
    ['sender', explorerLink(ctx.config, sender)],
    ['bond admin', explorerLink(ctx.config, bondAdmin)],
    ['target rate', bps(opts.targetRateBps)],
    ['stx value ratio', `${opts.stxValueRatio} uSTX / 100 sats`],
    ['min stx ratio', bps(opts.minUstxRatioBps)],
    ['early-unlock bytes', `${earlyUnlockBytesHex.length / 2} bytes${earlyUnlockDefaulted ? ' — 21<bond-admin pubkey>ac (OP_CHECKSIG)' : ''}`],
    ['allowlist', allowlistSummary(opts.allowlist, totalAllowSats)],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const scheduleRows: Row[] = [
    ['first reward cycle', firstRewardCycle],
    ['bond start height', `${startBurnHeight} (Bitcoin)`],
    ['unlock cycle', unlockCycle],
    ['setup window', windowStatus(bitcoinHeight, windowOpenHeight, startBurnHeight)],
  ];

  const json = {
    sender,
    bondAdmin,
    bondIndex: opts.bondIndex,
    targetRateBps: opts.targetRateBps,
    stxValueRatio: opts.stxValueRatio,
    minUstxRatioBps: opts.minUstxRatioBps,
    earlyUnlockBytes: earlyUnlockBytesHex,
    earlyUnlockDefaulted,
    allowlist: opts.allowlist,
    totalAllowSats,
    firstRewardCycle,
    bondStartHeight: startBurnHeight,
    unlockCycle,
    windowOpenHeight,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Setup bond ${opts.bondIndex} (dry run)`);
      printRows(baseRows);
      printAllowlist(ctx, opts.allowlist);
      printSection('Schedule');
      printRows(scheduleRows);
      for (const blocker of blockers) printNote(blocker);
      if (earlyUnlockDefaulted) {
        printNote('early-unlock-bytes defaulted to the bond-admin key’s OP_CHECKSIG fragment (unlock-script) — pass --early-unlock-bytes to override');
      }
      printNote('re-run with --broadcast to sign with POX5_BOND_ADMIN_PRIVATE_KEY (or POX5_STX_PRIVATE_KEY) and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`setup-bond would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection(`Setup bond ${opts.bondIndex}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) printNote('the transaction reverted on-chain — the bond was not set up');
    else if (outcome.pending) printNote('still pending — re-check the explorer link or pox5 bond');
    printAllowlist(ctx, opts.allowlist);
    printSection('Schedule');
    printRows(scheduleRows);
  });
  if (outcome.aborted) process.exitCode = 1;
}

function allowlistSummary(allowlist: AllowEntry[], total: bigint): string {
  if (allowlist.length === 0) return 'none';
  return `${allowlist.length} staker${allowlist.length === 1 ? '' : 's'} (${sats(total)})`;
}

function printAllowlist(ctx: Ctx, allowlist: AllowEntry[]): void {
  for (const e of allowlist) {
    process.stdout.write(`  ${dim('•')} ${explorerLink(ctx.config, e.staker)} ${dim('→')} ${sats(e.maxSats)}\n`);
  }
}

function windowStatus(bitcoinHeight: number, open: number, start: number): string {
  if (bitcoinHeight < open) return `opens at ${open} (in ${open - bitcoinHeight} blocks), closes before ${start}`;
  if (bitcoinHeight >= start) return `closed at ${start} (${bitcoinHeight - start} blocks ago)`;
  return `open now, closes before ${start} (in ${start - bitcoinHeight} blocks)`;
}
