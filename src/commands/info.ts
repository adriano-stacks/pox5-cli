import { currentDistributionCycle, fetchPoxInfo, isInPreparePhase } from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { callPoxReadOnly, fetchSbtcContractId, resolveFirstPox5Cycle } from '../pox.js';
import { explorerLink } from '../explorer.js';
import { bitcoinBlocks, dim, link, output, printRows, printSection, stx, type Row } from '../output.js';

export async function infoCommand(ctx: Ctx): Promise<void> {
  const [pox, poxRead, nextCycle, bitcoinBlockSeconds, sbtcContract] = await Promise.all([
    fetchPoxInfo(ctx.net),
    callPoxReadOnly(ctx, 'get-pox-info', []),
    fetchNextCycleBlocks(ctx),
    estimateBitcoinBlockSeconds(ctx),
    fetchSbtcContractId(ctx),
  ]);
  const stakingMinUstx = (poxRead as { value: { value: Record<string, { value: bigint }> } }).value.value[
    'min-amount-ustx'
  ]!.value;
  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const inPrepare = isInPreparePhase({ burnHeight: bitcoinHeight, poxInfo: pox });
  const distCycle = currentDistributionCycle(pox);
  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);

  const minutesUntilPrepare = minutesFor(nextCycle.untilPrepare, bitcoinBlockSeconds);
  const minutesUntilNewCycle = minutesFor(nextCycle.untilReward, bitcoinBlockSeconds);
  const untilPrepare = countdown(nextCycle.untilPrepare, minutesUntilPrepare);
  const untilNewCycle = countdown(nextCycle.untilReward, minutesUntilNewCycle);

  output(
    ctx,
    {
      contractId: pox.contractId,
      sbtcContract: sbtcContract ?? null,
      bitcoinBlockHeight: bitcoinHeight,
      firstBitcoinBlockHeight: pox.firstBurnchainBlockHeight,
      rewardCycleId: pox.rewardCycleId,
      rewardCycleLength: pox.rewardCycleLength,
      prepareCycleLength: pox.prepareCycleLength,
      inPreparePhase: inPrepare,
      blocksUntilPreparePhase: nextCycle.untilPrepare ?? null,
      minutesUntilPreparePhase: minutesUntilPrepare ?? null,
      blocksUntilNewCycle: nextCycle.untilReward ?? null,
      minutesUntilNewCycle: minutesUntilNewCycle ?? null,
      bitcoinBlockSeconds: bitcoinBlockSeconds ?? null,
      distributionCycle: distCycle,
      firstPox5RewardCycle: firstPox5 ?? null,
      stakingMinimumUstx: stakingMinUstx,
      contractVersions: pox.contractVersions.map((v) => ({
        contractId: v.contractId,
        activationBitcoinBlockHeight: v.activationBurnchainBlockHeight,
        firstRewardCycleId: v.firstRewardCycleId,
      })),
      currentCycle: pox.currentCycle,
      nextCycle: pox.nextCycle,
    },
    () => {
      printSection('Network');
      printRows([
        ['contract', explorerLink(ctx.config, pox.contractId)],
        ['sBTC token', sbtcContract ? explorerLink(ctx.config, sbtcContract) : null],
        ['baseUrl', link(ctx.config.stacksApiUrl, ctx.config.stacksApiUrl)],
        ['chainId', ctx.config.network.chainId],
      ]);

      const activeName = pox.contractId.split('.')[1] ?? pox.contractId;
      const activations: Row[] = pox.contractVersions.map((v) => {
        const name = v.contractId.split('.')[1] ?? v.contractId;
        const marker = name === activeName ? '  ← active' : '';
        return [
          explorerLink(ctx.config, v.contractId, name),
          `Bitcoin block ${v.activationBurnchainBlockHeight} (first cycle ${v.firstRewardCycleId})${marker}`,
        ];
      });
      if (!pox.contractVersions.some((v) => (v.contractId.split('.')[1] ?? v.contractId) === activeName)) {
        activations.push([
          explorerLink(ctx.config, pox.contractId, activeName),
          dim('active — activation height not advertised by /v2/pox'),
        ]);
      }
      printSection('PoX activations');
      printRows(activations);

      printSection('Bitcoin chain');
      printRows([
        ['Bitcoin block height', bitcoinHeight],
        ['first Bitcoin block height', pox.firstBurnchainBlockHeight],
        ['reward cycle', pox.rewardCycleId],
        ['cycle length', bitcoinBlocks(pox.rewardCycleLength)],
        ['prepare length', bitcoinBlocks(pox.prepareCycleLength)],
        ['in prepare phase', inPrepare],
        ['until prepare phase', untilPrepare],
        ['until next cycle', untilNewCycle],
        ['distribution cycle', distCycle],
        ['first PoX-5 cycle', firstPox5 ?? null],
        ['staking minimum', stx(stakingMinUstx)],
      ]);

      const cycleRows = (label: string, c: typeof pox.currentCycle): Row[] => [
        [`${label} id`, c.id],
        [`${label} staked`, stx(c.stakedUstx)],
        [`${label} pox active`, c.isPoxActive],
      ];
      printSection('Cycles');
      printRows([...cycleRows('current', pox.currentCycle), ...cycleRows('next', pox.nextCycle)]);
    },
  );
}

async function fetchNextCycleBlocks(ctx: Ctx): Promise<{ untilPrepare?: number; untilReward?: number }> {
  try {
    const res = await fetch(`${ctx.config.stacksApiUrl}/v2/pox`);
    if (!res.ok) return {};
    const nc = (
      (await res.json()) as {
        next_cycle?: { blocks_until_prepare_phase?: number; blocks_until_reward_phase?: number };
      }
    ).next_cycle;
    return { untilPrepare: nc?.blocks_until_prepare_phase, untilReward: nc?.blocks_until_reward_phase };
  } catch {
    return {};
  }
}

function minutesFor(blocks: number | undefined, secondsPerBlock: number | undefined): number | undefined {
  return blocks !== undefined && blocks > 0 && secondsPerBlock !== undefined
    ? Math.round((blocks * secondsPerBlock) / 60)
    : undefined;
}

function countdown(blocks: number | undefined, minutes: number | undefined): string | null {
  if (blocks === undefined) return null;
  if (blocks <= 0) return 'now';
  return minutes !== undefined ? `${bitcoinBlocks(blocks)} (~${humanizeMinutes(minutes)})` : bitcoinBlocks(blocks);
}

async function estimateBitcoinBlockSeconds(ctx: Ctx): Promise<number | undefined> {
  try {
    const res = await fetch(`${ctx.config.extendedApiUrl}/v2/burn-blocks?limit=12`);
    if (!res.ok) return undefined;
    const results = ((await res.json()) as { results?: { burn_block_time: number }[] }).results ?? [];
    const diffs: number[] = [];
    for (let i = 1; i < results.length; i++) {
      const dt = results[i - 1]!.burn_block_time - results[i]!.burn_block_time;
      if (dt > 0) diffs.push(dt);
    }
    if (diffs.length === 0) return undefined;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  } catch {
    return undefined;
  }
}

function humanizeMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
