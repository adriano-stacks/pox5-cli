import { currentDistributionCycle, fetchPoxInfo, isInPreparePhase } from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { callPoxReadOnly, resolveFirstPox5Cycle } from '../pox.js';
import { output, printRows, printSection, stx, type Row } from '../output.js';

export async function infoCommand(ctx: Ctx): Promise<void> {
  const [pox, poxRead] = await Promise.all([fetchPoxInfo(ctx.net), callPoxReadOnly(ctx, 'get-pox-info', [])]);
  const stakingMinUstx = (poxRead as { value: { value: Record<string, { value: bigint }> } }).value.value[
    'min-amount-ustx'
  ]!.value;
  const burnHeight = pox.currentBurnchainBlockHeight;
  const inPrepare = isInPreparePhase({ burnHeight, poxInfo: pox });
  const distCycle = currentDistributionCycle(pox);
  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);

  output(
    ctx,
    {
      contractId: pox.contractId,
      burnHeight,
      firstBurnchainBlockHeight: pox.firstBurnchainBlockHeight,
      rewardCycleId: pox.rewardCycleId,
      rewardCycleLength: pox.rewardCycleLength,
      prepareCycleLength: pox.prepareCycleLength,
      inPreparePhase: inPrepare,
      distributionCycle: distCycle,
      firstPox5RewardCycle: firstPox5 ?? null,
      stakingMinimumUstx: stakingMinUstx,
      currentCycle: pox.currentCycle,
      nextCycle: pox.nextCycle,
    },
    () => {
      printSection('Network');
      printRows([
        ['contract', pox.contractId],
        ['baseUrl', ctx.config.stacksApiUrl],
        ['chainId', ctx.config.network.chainId],
      ]);

      printSection('Burn chain');
      printRows([
        ['burn height', burnHeight],
        ['first burn height', pox.firstBurnchainBlockHeight],
        ['reward cycle', pox.rewardCycleId],
        ['cycle length', `${pox.rewardCycleLength} blocks`],
        ['prepare length', `${pox.prepareCycleLength} blocks`],
        ['in prepare phase', inPrepare],
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
