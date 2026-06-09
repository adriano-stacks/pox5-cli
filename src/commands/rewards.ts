import {
  fetchEarned,
  fetchSignerRewardsPerTokenSettled,
  fetchSignerSharesStakedByBond,
  fetchSignerSharesStakedByCycle,
  fetchSignerUnclaimedRewards,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { explorerLink } from '../explorer.js';
import { output, printRows, printSection, sats, stx } from '../output.js';

export interface RewardsOpts {
  bond?: number;
  cycle?: number;
}

export async function rewardsCommand(ctx: Ctx, signerManager: string, opts: RewardsOpts): Promise<void> {
  if ((opts.bond === undefined) === (opts.cycle === undefined)) {
    throw new CliError('provide exactly one of --bond <index> or --cycle <cycle>');
  }
  const isBond = opts.bond !== undefined;
  const index = (isBond ? opts.bond : opts.cycle)!;

  const [earned, unclaimed, rptSettled, shares] = await Promise.all([
    fetchEarned({ signerManager, index, isBond, ...ctx.net }),
    fetchSignerUnclaimedRewards({ signerManager, index, isBond, ...ctx.net }),
    fetchSignerRewardsPerTokenSettled({ signerManager, index, isBond, ...ctx.net }),
    isBond
      ? fetchSignerSharesStakedByBond({ signerManager, bondIndex: index, ...ctx.net })
      : fetchSignerSharesStakedByCycle({ signerManager, rewardCycle: index, ...ctx.net }),
  ]);

  output(
    ctx,
    { signerManager, leg: isBond ? 'bond' : 'stx-cycle', index, earned, unclaimed, rptSettled, shares },
    () => {
      printSection(`Rewards — ${explorerLink(ctx.config, signerManager)}`);
      printRows([
        ['leg', isBond ? `bond ${index}` : `STX cycle ${index}`],
        ['earned (claimable)', sats(earned)],
        ['settled unclaimed', sats(unclaimed)],
        ['rewards-per-token settled', rptSettled],
        ['shares', isBond ? sats(shares) : stx(shares)],
      ]);
    },
  );
}
