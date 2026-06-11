import { firstPox5RewardCycle } from '@stacks/bitcoin-staking';
import type { PoxInfo } from '@stacks/bitcoin-staking';
import { hexToBytes } from '@stacks/common';
import {
  ClarityType,
  bufferCV,
  fetchCallReadOnlyFunction,
  principalCV,
  uintCV,
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

export interface BondConfig {
  bondIndex: number;
  targetRateBps: number;
  stxValueRatio: bigint;
  minUstxRatioBps: number;
  earlyUnlockBytes: string;
}

export async function fetchBondConfig(ctx: Ctx, bondIndex: number): Promise<BondConfig | undefined> {
  const result = await callPoxReadOnly(ctx, 'get-protocol-bond', [uintCV(bondIndex)]);
  if (result.type !== ClarityType.OptionalSome) return undefined;
  const f = (result.value as { value: Record<string, ClarityValue> }).value;
  return {
    bondIndex,
    targetRateBps: Number((f['target-rate'] as { value: bigint }).value),
    stxValueRatio: (f['stx-value-ratio'] as { value: bigint }).value,
    minUstxRatioBps: Number((f['min-ustx-ratio'] as { value: bigint }).value),
    earlyUnlockBytes: (f['early-unlock-bytes'] as { value: string }).value,
  };
}

export async function fetchLockupOutputScript(
  ctx: Ctx,
  opts: { staker: string; unlockHeight: number; stakerUnlockBytes: Uint8Array; earlyUnlockBytes: string },
): Promise<string> {
  const result = await callPoxReadOnly(ctx, 'construct-lockup-output-script', [
    principalCV(opts.staker),
    uintCV(opts.unlockHeight),
    bufferCV(opts.stakerUnlockBytes),
    bufferCV(hexToBytes(opts.earlyUnlockBytes)),
  ]);
  if (result.type !== ClarityType.Buffer) {
    throw new CliError(`construct-lockup-output-script returned unexpected type ${result.type}`);
  }
  return result.value.replace(/^0x/, '');
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
