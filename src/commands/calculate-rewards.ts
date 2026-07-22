import {
  BOND_END_OFFSET_PERIODS,
  buildCalculateRewards,
  burnHeightToRewardCycle,
  currentDistributionCycle,
  distributionCycleToBurnHeight,
  fetchEligibleCalculateRewards,
  fetchPoxInfo,
} from '@stacks/bitcoin-staking';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError, eligibilityBlockers } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchRewardsState } from '../pox.js';
import { discoverActiveBonds } from '../projection.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { bps, output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const RESERVE_RATIO_BPS = 1500;

export interface CalculateRewardsOpts {
  bonds: number[];
  fee: bigint;
  broadcast: boolean;
}

export async function calculateRewardsCommand(ctx: Ctx, opts: CalculateRewardsOpts): Promise<void> {
  if (opts.bonds.length > BOND_END_OFFSET_PERIODS) {
    throw new CliError(`at most ${BOND_END_OFFSET_PERIODS} bonds can be passed (got ${opts.bonds.length})`);
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
  if (autoDiscovered) {
    const active = await discoverActiveBonds(ctx, pox, calcHeight);
    bonds = active.map((a) => a.index);
  } else {
    bonds = opts.bonds;
  }

  const [state, nonce, eligibility] = await Promise.all([
    fetchRewardsState(ctx),
    fetchNonce({ address: sender, ...ctx.net }),
    fetchEligibleCalculateRewards({ bondIndices: bonds, poxInfo: pox, ...ctx.net }),
  ]);

  const tx = await buildCalculateRewards({
    bondIndices: bonds,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });

  const reserveCutMax = (state.newRewards * BigInt(RESERVE_RATIO_BPS)) / 10000n;

  const blockers = eligibilityBlockers(eligibility);
  if (state.newRewards === 0n) {
    blockers.push('no new sBTC has arrived since the last distribution — nothing to settle (fund the contract with faucet sbtc)');
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
