import type { Ctx } from '../context.js';
import { resolveStxAddress } from '../address.js';
import { explorerLink } from '../explorer.js';
import { fetchSignerRewardLeg } from '../pox.js';
import { output, printRows, printSection, sats, stx } from '../output.js';

export interface RewardsOpts {
  cycle: number;
  bond?: number;
}

export async function rewardsCommand(ctx: Ctx, signerManagerArg: string | undefined, opts: RewardsOpts): Promise<void> {
  const signerManager = signerManagerArg ?? `${resolveStxAddress(ctx)}.signer-manager`;
  const isBond = opts.bond !== undefined;
  const leg = await fetchSignerRewardLeg(ctx, {
    signer: signerManager,
    rewardCycle: opts.cycle,
    bondIndex: opts.bond,
  });

  output(ctx, { signerManager, rewardCycle: opts.cycle, bondIndex: opts.bond ?? null, ...leg }, () => {
    printSection(`Rewards — ${explorerLink(ctx.config, signerManager)}`);
    printRows([
      ['leg', isBond ? `bond ${opts.bond} @ cycle ${opts.cycle}` : `STX-only cycle ${opts.cycle}`],
      ['earned (claimable)', sats(leg.earned)],
      ['settled unclaimed', sats(leg.unclaimed)],
      ['rewards-per-token settled', leg.rptSettled],
      ['shares', isBond ? sats(leg.shares) : stx(leg.shares)],
    ]);
  });
}
