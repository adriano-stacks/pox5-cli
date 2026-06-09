import { firstPox5RewardCycle } from '@stacks/bitcoin-staking';
import type { PoxInfo } from '@stacks/bitcoin-staking';
import { fetchCallReadOnlyFunction, type ClarityValue } from '@stacks/transactions';
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
