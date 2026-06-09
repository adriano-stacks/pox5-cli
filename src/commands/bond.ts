import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  bondPhaseRanges,
  fetchBond,
  fetchBondAllowance,
  fetchBondL1UnlockHeight,
  fetchPoxInfo,
  fetchTotalSbtcStakedForBond,
  type BondPhaseName,
  type PoxInfo,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveFirstPox5Cycle, withFirstPox5Cycle } from '../pox.js';
import { bps, output, printNote, printRows, printSection, sats, type Row } from '../output.js';

export interface BondOpts {
  address?: string;
}

function phaseAt(burnHeight: number, pox: PoxInfo, bondIndex: number): BondPhaseName | 'pre-announce' | 'ended' {
  const ranges = bondPhaseRanges({ bondIndex, poxInfo: pox });
  if (ranges.length === 0 || burnHeight < ranges[0]!.startBurnHeight) return 'pre-announce';
  for (const r of ranges) {
    if (burnHeight >= r.startBurnHeight && burnHeight < r.endBurnHeight) return r.name;
  }
  return 'ended';
}

export async function bondCommand(ctx: Ctx, bondIndex: number, opts: BondOpts): Promise<void> {
  const [pox, bond, filledSbtc] = await Promise.all([
    fetchPoxInfo(ctx.net),
    fetchBond({ bondIndex, ...ctx.net }),
    fetchTotalSbtcStakedForBond({ bondIndex, ...ctx.net }),
  ]);

  if (!bond) throw new CliError(`bond ${bondIndex} is not configured on this contract`);

  const allowanceAddress = opts.address ?? ctx.config.stxAddress;
  const allowance = allowanceAddress
    ? await fetchBondAllowance({ bondIndex, address: allowanceAddress, ...ctx.net })
    : undefined;

  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);
  let schedule:
    | { firstRewardCycle: number; openBurnHeight: number; status: string; l1UnlockHeight: bigint }
    | undefined;
  if (firstPox5 !== undefined) {
    const p = withFirstPox5Cycle(pox, firstPox5);
    schedule = {
      firstRewardCycle: bondPeriodToRewardCycle({ bondIndex, poxInfo: p }),
      openBurnHeight: bondPeriodToBurnHeight({ bondIndex, poxInfo: p }),
      status: phaseAt(pox.currentBurnchainBlockHeight, p, bondIndex),
      l1UnlockHeight: await fetchBondL1UnlockHeight({ bondIndex, ...ctx.net }),
    };
  }

  output(
    ctx,
    {
      bondIndex: bond.bondIndex,
      targetRateBps: bond.targetRateBps,
      stxValueRatio: bond.stxValueRatio,
      minUstxRatioBps: bond.minUstxRatioBps,
      earlyUnlockSigners: bond.earlyUnlockSigners,
      earlyUnlockAdmin: bond.earlyUnlockAdmin,
      capacitySats: bond.capacitySats ?? null,
      filledSbtc,
      allowanceSats: allowance ?? null,
      schedule: schedule ?? null,
    },
    () => {
      printSection(`Bond ${bondIndex}`);
      const rows: Row[] = [
        ['target rate', bps(bond.targetRateBps)],
        ['stx value ratio', `${bond.stxValueRatio} uSTX / 100 sats`],
        ['min stx ratio', bps(bond.minUstxRatioBps)],
        ['early-unlock admin', bond.earlyUnlockAdmin],
        ['early-unlock signers', bond.earlyUnlockSigners],
      ];
      if (bond.capacitySats !== undefined) rows.push(['capacity', sats(bond.capacitySats)]);
      rows.push(['filled (sBTC)', sats(filledSbtc)]);
      if (allowance !== undefined) rows.push([`allowance (${allowanceAddress})`, sats(allowance)]);
      printRows(rows);

      printSection('Schedule');
      if (schedule) {
        printRows([
          ['status', schedule.status],
          ['first reward cycle', schedule.firstRewardCycle],
          ['open burn height', schedule.openBurnHeight],
          ['L1 unlock height', schedule.l1UnlockHeight],
        ]);
      } else {
        printNote('unavailable — set POX5_FIRST_POX5_CYCLE / --first-pox5-cycle to derive');
      }
    },
  );
}
