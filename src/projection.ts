import {
  bondPeriodToRewardCycle,
  burnHeightToRewardCycle,
  currentDistributionCycle,
  distributionCycleToBurnHeight,
  isBondActiveAtHeight,
  type PoxInfo,
} from '@stacks/bitcoin-staking';
import type { Ctx } from './context.js';
import {
  fetchBondConfig,
  fetchRewardsState,
  fetchSignerShares,
  fetchTotalSharesStaked,
  requirePoxWithBondCycle,
  type BondConfig,
} from './pox.js';

const PRECISION = 1000000000000000000n;
const RESERVE_RATIO_BPS = 1500n;

export interface ActiveBond {
  index: number;
  config: BondConfig;
}

export async function discoverActiveBonds(ctx: Ctx, pox: PoxInfo, calcHeight: number): Promise<ActiveBond[]> {
  const p = requirePoxWithBondCycle(ctx, pox);
  const calcCycle = burnHeightToRewardCycle({ burnHeight: calcHeight, poxInfo: p });
  let latest = 0;
  while (bondPeriodToRewardCycle({ bondIndex: latest + 1, poxInfo: p }) <= calcCycle) latest++;

  const candidates: number[] = [];
  for (let offset = 0; offset <= 5 && offset <= latest; offset++) candidates.push(latest - offset);

  const checked = await Promise.all(
    candidates.map(async (index): Promise<ActiveBond | undefined> => {
      const config = await fetchBondConfig(ctx, index);
      if (config === undefined) return undefined;
      if (!isBondActiveAtHeight({ bondIndex: index, burnHeight: calcHeight, poxInfo: p })) return undefined;
      return { index, config };
    }),
  );

  return checked
    .filter((b): b is ActiveBond => b !== undefined)
    .sort((a, b) =>
      a.config.stxValueRatio > b.config.stxValueRatio
        ? -1
        : a.config.stxValueRatio < b.config.stxValueRatio
          ? 1
          : a.index - b.index,
    );
}

export interface LegPending {
  bondIndex?: number;
  pending: bigint;
}

export interface PendingProjection {
  cycle: number;
  calcHeight: number;
  gross: bigint;
  nextCycle: boolean;
  legs: LegPending[];
  totalPending: bigint;
}

export async function projectPendingRewards(ctx: Ctx, pox: PoxInfo, signer: string): Promise<PendingProjection> {
  const state = await fetchRewardsState(ctx);

  let distCycle = currentDistributionCycle(pox);
  let calcHeight = distributionCycleToBurnHeight({ distributionCycle: distCycle, poxInfo: pox }) - 1;
  const nextCycle = calcHeight <= state.lastComputeHeight;
  if (nextCycle) {
    distCycle += 1;
    calcHeight = distributionCycleToBurnHeight({ distributionCycle: distCycle, poxInfo: pox }) - 1;
  }
  const cycle = burnHeightToRewardCycle({ burnHeight: calcHeight, poxInfo: pox });

  const active = await discoverActiveBonds(ctx, pox, calcHeight);

  const [bondData, stxTotal, stxSignerShares] = await Promise.all([
    Promise.all(
      active.map(async (bond) => {
        const [totalSats, signerShares] = await Promise.all([
          fetchTotalSharesStaked(ctx, { rewardCycle: cycle, bondIndex: bond.index }),
          fetchSignerShares(ctx, { signer, rewardCycle: cycle, bondIndex: bond.index }),
        ]);
        return { bond, totalSats, signerShares };
      }),
    ),
    fetchTotalSharesStaked(ctx, { rewardCycle: cycle }),
    fetchSignerShares(ctx, { signer, rewardCycle: cycle }),
  ]);

  let available = state.newRewards;
  const legs: LegPending[] = [];
  for (const { bond, totalSats, signerShares } of bondData) {
    const targetYield = ((totalSats * BigInt(bond.config.targetRateBps)) / 10000n) / 50n;
    const earned = available >= targetYield ? targetYield : available;
    available -= earned;
    const accruedRpt = totalSats === 0n ? 0n : (earned * PRECISION) / totalSats;
    const pending = (signerShares * accruedRpt) / PRECISION;
    if (pending > 0n) legs.push({ bondIndex: bond.index, pending });
  }

  const reserveCut = (available * RESERVE_RATIO_BPS) / 10000n;
  const stxStakerRewards = available - reserveCut;
  if (stxTotal > 0n) {
    const accruedRpt = (stxStakerRewards * PRECISION) / stxTotal;
    const pending = (stxSignerShares * accruedRpt) / PRECISION;
    if (pending > 0n) legs.unshift({ bondIndex: undefined, pending });
  }

  const totalPending = legs.reduce((acc, l) => acc + l.pending, 0n);
  return { cycle, calcHeight, gross: state.newRewards, nextCycle, legs, totalPending };
}
