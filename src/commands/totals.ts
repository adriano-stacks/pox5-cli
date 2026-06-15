import {
  fetchTotalSbtcStaked,
  fetchTotalSbtcStakedForBond,
  fetchTotalSharesStakedForCycle,
  fetchTotalUstxStacked,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { fetchRewardsState } from '../pox.js';
import { output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

export interface TotalsOpts {
  bond?: number;
  cycle?: number;
}

export async function totalsCommand(ctx: Ctx, opts: TotalsOpts): Promise<void> {
  const [sbtcTotal, rewards, bond, cycle] = await Promise.all([
    fetchTotalSbtcStaked(ctx.net),
    fetchRewardsState(ctx),
    opts.bond === undefined
      ? undefined
      : fetchTotalSbtcStakedForBond({ bondIndex: opts.bond, ...ctx.net }).then((filledSbtc) => ({
          index: opts.bond!,
          filledSbtc,
        })),
    opts.cycle === undefined
      ? undefined
      : Promise.all([
          fetchTotalUstxStacked({ rewardCycle: opts.cycle, ...ctx.net }),
          fetchTotalSharesStakedForCycle({ rewardCycle: opts.cycle, ...ctx.net }),
        ]).then(([ustx, shares]) => ({ index: opts.cycle!, ustx, shares })),
  ]);

  output(ctx, { sbtcTotal, rewards, bond: bond ?? null, cycle: cycle ?? null }, () => {
    const rows: Row[] = [
      ['total sBTC staked', sats(sbtcTotal)],
      ['reserve fund', sats(rewards.reserveBalance)],
      ['undistributed rewards', sats(rewards.newRewards)],
      ['last distribution height', rewards.lastComputeHeight === 0 ? 'never' : `${rewards.lastComputeHeight} (Bitcoin)`],
    ];
    if (bond) {
      rows.push([`bond ${bond.index} filled (sBTC = shares)`, sats(bond.filledSbtc)]);
    }
    if (cycle) {
      rows.push([`cycle ${cycle.index} STX stacked`, stx(cycle.ustx)]);
      rows.push([`cycle ${cycle.index} shares`, stx(cycle.shares)]);
    }
    printSection('Protocol totals');
    printRows(rows);
    printNote('the reserve fund takes 15% of each distribution; undistributed rewards settle on the next calculate-rewards');
  });
}
