import {
  buildCalculateRewards,
  burnHeightToRewardCycle,
  currentDistributionCycle,
  distributionCycleToBurnHeight,
  fetchPoxInfo,
} from '@stacks/bitcoin-staking';
import {
  TransactionSigner,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchBondConfig, fetchRewardsState, type BondConfig } from '../pox.js';
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

  const [state, configs, nonce] = await Promise.all([
    fetchRewardsState(ctx),
    Promise.all(opts.bonds.map((i) => fetchBondConfig(ctx, i))),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);

  const tx = await buildCalculateRewards({
    bondIndices: opts.bonds,
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
  const missing = opts.bonds.filter((_i, idx) => configs[idx] === undefined);
  if (missing.length > 0) {
    blockers.push(`bond(s) ${missing.join(', ')} are not configured (ERR_BOND_NOT_FOUND u7)`);
  }
  const present = configs.filter((c): c is BondConfig => c !== undefined);
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

  const baseRows: Row[] = [
    ['caller', explorerLink(ctx.config, sender)],
    ['distribution cycle', distCycle],
    ['calculation height', `${calcHeight} (Bitcoin)`],
    ['STX-only leg cycle', stxCycle],
    ['bonds', opts.bonds.length ? opts.bonds.join(', ') : 'none (STX leg + reserve only)'],
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
    bonds: opts.bonds,
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
      printNote('every bond active at the calculation height must be included or the call reverts (ERR_ACTIVE_BOND_NOT_INCLUDED u33)');
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`calculate-rewards would be rejected: ${blockers.join('; ')}`);
  }

  const signer = new TransactionSigner(tx);
  signer.signOrigin(privateKey);
  const result = (await broadcastTransaction({ transaction: signer.getTxInComplete(), ...ctx.net })) as {
    txid?: string;
    error?: string;
    reason?: string;
  };
  if (result.error) throw new CliError(`broadcast rejected: ${result.reason ?? result.error}`);
  const txid = result.txid!;

  output(ctx, { ...json, txid }, () => {
    printSection('Calculate rewards');
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)]]);
    printNote('signer-managers can now pull their share with claim-rewards');
  });
}
