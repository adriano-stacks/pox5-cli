import {
  fetchLastAccountedRewards,
  fetchLastRewardComputeHeight,
  fetchNewRewards,
  fetchReserveBalance,
  fetchRewards,
  firstPox5RewardCycle,
} from '@stacks/bitcoin-staking';
import type { PoxInfo } from '@stacks/bitcoin-staking';
import {
  ClarityType,
  fetchCallReadOnlyFunction,
  principalCV,
  type ClarityValue,
} from '@stacks/transactions';
import type { Ctx } from './context.js';
import { CliError } from './errors.js';

const POX5_CONTRACT_NAME = 'pox-5';

export function callPoxReadOnly(
  ctx: Ctx,
  functionName: string,
  functionArgs: ClarityValue[],
): Promise<ClarityValue> {
  const boot = ctx.net.network.bootAddress;
  return fetchCallReadOnlyFunction({
    contractAddress: boot,
    contractName: POX5_CONTRACT_NAME,
    functionName,
    functionArgs,
    senderAddress: boot,
    ...ctx.net,
  });
}

export async function fetchSbtcContractId(ctx: Ctx): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${ctx.config.stacksApiUrl}/v2/contracts/source/${ctx.net.network.bootAddress}/pox-5?proof=0`,
    );
    if (!res.ok) return undefined;
    const src = ((await res.json()) as { source?: string }).source;
    return src?.match(/'(S[0-9A-Z]+\.sbtc-token)/)?.[1];
  } catch {
    return undefined;
  }
}

export async function fetchSbtcBalance(
  ctx: Ctx,
  address: string,
): Promise<{ contractId: string; balance: bigint } | undefined> {
  const contractId = await fetchSbtcContractId(ctx);
  if (!contractId) return undefined;
  const [contractAddress, contractName] = contractId.split('.');
  try {
    const result = await fetchCallReadOnlyFunction({
      contractAddress: contractAddress!,
      contractName: contractName!,
      functionName: 'get-balance',
      functionArgs: [principalCV(address)],
      senderAddress: ctx.net.network.bootAddress,
      ...ctx.net,
    });
    if (result.type !== ClarityType.ResponseOk) return undefined;
    const inner = (result as { value: ClarityValue }).value;
    if (inner.type !== ClarityType.UInt) return undefined;
    return { contractId, balance: (inner as { value: bigint }).value };
  } catch {
    return undefined;
  }
}

export interface RewardsState {
  reserveBalance: bigint;
  rewardsBalance: bigint;
  newRewards: bigint;
  lastAccounted: bigint;
  lastComputeHeight: number;
}

export async function fetchRewardsState(ctx: Ctx): Promise<RewardsState> {
  const [reserveBalance, rewardsBalance, newRewards, lastAccounted, lastComputeHeight] = await Promise.all([
    fetchReserveBalance(ctx.net),
    fetchRewards(ctx.net),
    fetchNewRewards(ctx.net),
    fetchLastAccountedRewards(ctx.net),
    fetchLastRewardComputeHeight(ctx.net),
  ]);
  return { reserveBalance, rewardsBalance, newRewards, lastAccounted, lastComputeHeight };
}

export function resolveFirstPox5Cycle(ctx: Ctx, pox: PoxInfo): number | undefined {
  return firstPox5RewardCycle(pox) ?? ctx.config.firstPox5Cycle;
}

export function withFirstPox5Cycle(pox: PoxInfo, firstCycle: number): PoxInfo {
  if (firstPox5RewardCycle(pox) !== undefined) return pox;
  const bootAddress = pox.contractId.split('.')[0] ?? pox.contractId;
  return {
    ...pox,
    contractVersions: [
      ...pox.contractVersions,
      {
        contractId: `${bootAddress}.pox-5`,
        activationBurnchainBlockHeight: pox.firstBurnchainBlockHeight,
        firstRewardCycleId: firstCycle,
      },
    ],
  };
}

export function requirePoxWithBondCycle(ctx: Ctx, pox: PoxInfo): PoxInfo {
  const cycle = resolveFirstPox5Cycle(ctx, pox);
  if (cycle === undefined) {
    throw new CliError(
      'first PoX-5 reward cycle is unknown: the node does not advertise a `.pox-5` ' +
        'contract version in /v2/pox. Set POX5_FIRST_POX5_CYCLE (or --first-pox5-cycle) ' +
        'to enable bond/schedule derivation.',
    );
  }
  return withFirstPox5Cycle(pox, cycle);
}
