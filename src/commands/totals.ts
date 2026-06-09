import {
  fetchTotalSbtcStaked,
  fetchTotalSbtcStakedForBond,
  fetchTotalSharesStakedForCycle,
  fetchTotalUstxStacked,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { output, printRows, printSection, sats, stx, type Row } from '../output.js';

export interface TotalsOpts {
  bond?: number;
  cycle?: number;
}

export async function totalsCommand(ctx: Ctx, opts: TotalsOpts): Promise<void> {
  const [sbtcTotal, bond, cycle] = await Promise.all([
    fetchTotalSbtcStaked(ctx.net),
    opts.bond === undefined
      ? undefined
      : Promise.all([
          fetchTotalSbtcStakedForBond({ bondIndex: opts.bond, ...ctx.net }),
          fetchTotalSharesStakedForCycle({ index: opts.bond, isBond: true, ...ctx.net }),
        ]).then(([filledSbtc, shares]) => ({ index: opts.bond!, filledSbtc, shares })),
    opts.cycle === undefined
      ? undefined
      : Promise.all([
          fetchTotalUstxStacked({ rewardCycle: opts.cycle, ...ctx.net }),
          fetchTotalSharesStakedForCycle({ index: opts.cycle, isBond: false, ...ctx.net }),
        ]).then(([ustx, shares]) => ({ index: opts.cycle!, ustx, shares })),
  ]);

  output(ctx, { sbtcTotal, bond: bond ?? null, cycle: cycle ?? null }, () => {
    const rows: Row[] = [['total sBTC staked', sats(sbtcTotal)]];
    if (bond) {
      rows.push([`bond ${bond.index} filled`, sats(bond.filledSbtc)]);
      rows.push([`bond ${bond.index} shares`, sats(bond.shares)]);
    }
    if (cycle) {
      rows.push([`cycle ${cycle.index} STX stacked`, stx(cycle.ustx)]);
      rows.push([`cycle ${cycle.index} shares`, stx(cycle.shares)]);
    }
    printSection('Protocol totals');
    printRows(rows);
  });
}
