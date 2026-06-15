import {
  buildCalculateRewards,
  burnHeightToRewardCycle,
  currentDistributionCycle,
  distributionCycleToBurnHeight,
  fetchPoxInfo,
  fetchProtocolBond,
  type Bond,
} from '@stacks/bitcoin-staking';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchRewardsState } from '../pox.js';
import { discoverActiveBonds } from '../projection.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { bps, output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const RESERVE_RATIO_BPS = 1500;
const MAX_BOND_PERIODS = 6;

export interface CalculateRewardsOpts {
  bonds: number[];
  fee: bigint;
  broadcast: boolean;
}

export async function calculateRewardsCommand(ctx: Ctx, opts: CalculateRewardsOpts): Promise<void> {
  if (opts.bonds.length > MAX_BOND_PERIODS) {
    throw new CliError(`at most ${MAX_BOND_PERIODS} bonds can be passed (got ${opts.bonds.length})`);
  }

  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const pox = await fetchPoxInfo(ctx.net);
  const distCycle = currentDistributionCycle(pox);
  const calcHeight = distributionCycleToBurnHeight({ distributionCycle: distCycle, poxInfo: pox }) - 1;
  const stxCycle = burnHeightToRewardCycle({ burnHeight: calcHeight, poxInfo: pox });

  const autoDiscovered = opts.bonds.length === 0;
  let bonds: number[];
  let configs: (Bond | undefined)[];
  if (autoDiscovered) {
    const active = await discoverActiveBonds(ctx, pox, calcHeight);
    bonds = active.map((a) => a.index);
    configs = active.map((a) => a.config);
  } else {
    bonds = opts.bonds;
    configs = await Promise.all(bonds.map((i) => fetchProtocolBond({ bondIndex: i, ...ctx.net })));
  }

  const [state, nonce] = await Promise.all([
    fetchRewardsState(ctx),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);

  const tx = await buildCalculateRewards({
    bondIndices: bonds,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });

  const reserveCutMax = (state.newRewards * BigInt(RESERVE_RATIO_BPS)) / 10000n;

  const blockers: string[] = [];
  if (calcHeight <= state.lastComputeHeight) {
    blockers.push(
      `distribution height ${calcHeight} was already settled (last compute height ${state.lastComputeHeight}) — ` +
        'ERR_DISTRIBUTION_ALREADY_COMPUTED (u30); wait for the next distribution cycle',
    );
  }
  if (state.newRewards === 0n) {
    blockers.push('no new sBTC has arrived since the last distribution — nothing to settle (fund the contract with faucet sbtc)');
  }
  const missing = bonds.filter((_i, idx) => configs[idx] === undefined);
  if (missing.length > 0) {
    blockers.push(`bond(s) ${missing.join(', ')} are not configured (ERR_BOND_NOT_FOUND u7)`);
  }
  const present = configs.filter((c): c is Bond => c !== undefined);
  for (let i = 1; i < present.length; i++) {
    const prev = present[i - 1]!;
    const cur = present[i]!;
    const ordered =
      prev.stxValueRatio > cur.stxValueRatio ||
      (prev.stxValueRatio === cur.stxValueRatio && prev.bondIndex < cur.bondIndex);
    if (!ordered) {
      blockers.push(
        `bonds out of order at position ${i} (bond ${cur.bondIndex} after bond ${prev.bondIndex}) — ` +
          'must be descending stx-value-ratio, ascending index (ERR_INVALID_BOND_PERIOD_ORDERING u29)',
      );
      break;
    }
  }

  const bondsLabel = bonds.length
    ? `${bonds.join(', ')}${autoDiscovered ? ' (auto-detected active)' : ''}`
    : autoDiscovered
      ? 'none active at this height — STX leg + reserve only'
      : 'none (STX leg + reserve only)';

  const baseRows: Row[] = [
    ['caller', explorerLink(ctx.config, sender)],
    ['distribution cycle', distCycle],
    ['calculation height', `${calcHeight} (Bitcoin)`],
    ['STX-only leg cycle', stxCycle],
    ['bonds', bondsLabel],
    ['new rewards to settle', sats(state.newRewards)],
    ['reserve fund (current)', sats(state.reserveBalance)],
    ['reserve cut', `${bps(RESERVE_RATIO_BPS)} of the remainder after the bond waterfall (≤ ${sats(reserveCutMax)})`],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const json = {
    caller: sender,
    distributionCycle: distCycle,
    calculationHeight: calcHeight,
    stxCycle,
    bonds,
    autoDiscovered,
    newRewards: state.newRewards,
    reserveBalance: state.reserveBalance,
    reserveCutMax,
    lastComputeHeight: state.lastComputeHeight,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection('Calculate rewards (dry run)');
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      if (autoDiscovered) {
        printNote('the active bonds were auto-detected at the calculation height; pass --bond to override');
      } else {
        printNote('every bond active at the calculation height must be included or the call reverts (ERR_ACTIVE_BOND_NOT_INCLUDED u33) — omit --bond to auto-detect');
      }
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`calculate-rewards would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection('Calculate rewards');
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) {
      printNote('the transaction reverted on-chain — no distribution happened; nothing was settled');
    } else if (outcome.pending) {
      printNote('still pending — re-check the explorer link, then verify with pox5 totals / pox5 rewards');
    } else {
      printNote('signer-managers can now pull their share with claim-rewards');
    }
  });

  if (outcome.aborted) process.exitCode = 1;
}
