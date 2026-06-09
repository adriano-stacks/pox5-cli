import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  bondPhaseRanges,
  fetchBondAllowance,
  fetchBondL1UnlockHeight,
  fetchPoxInfo,
  fetchTotalSbtcStakedForBond,
  type BondPhaseName,
  type PoxInfo,
} from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { explorerLink } from '../explorer.js';
import { fetchBondConfig, resolveFirstPox5Cycle, withFirstPox5Cycle } from '../pox.js';
import { bps, dim, output, percent, printNote, printRows, printSection, sats, type Row } from '../output.js';

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;

export interface BondOpts {
  address?: string;
  allowlist?: boolean;
}

interface AllowlistEntry {
  staker: string;
  maxSats: bigint;
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
    fetchBondConfig(ctx, bondIndex),
    fetchTotalSbtcStakedForBond({ bondIndex, ...ctx.net }),
  ]);

  if (!bond) throw new CliError(`bond ${bondIndex} is not configured on this contract`);

  const allowanceAddress = opts.address ?? ctx.config.stxAddress;
  const allowance = allowanceAddress
    ? await fetchBondAllowance({ bondIndex, address: allowanceAddress, ...ctx.net })
    : undefined;

  let allowlist: AllowlistEntry[] | undefined;
  let allowlistTruncated = false;
  let capacitySats: bigint | undefined;
  if (opts.allowlist) {
    const scan = await scanBondAllowlist(ctx, bondIndex);
    allowlist = scan.entries;
    allowlistTruncated = scan.truncated;
    capacitySats = allowlist.reduce((sum, e) => sum + e.maxSats, 0n);
  }

  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);
  let schedule:
    | { firstRewardCycle: number; openBitcoinBlockHeight: number; status: string; l1UnlockHeight: bigint }
    | undefined;
  if (firstPox5 !== undefined) {
    const p = withFirstPox5Cycle(pox, firstPox5);
    schedule = {
      firstRewardCycle: bondPeriodToRewardCycle({ bondIndex, poxInfo: p }),
      openBitcoinBlockHeight: bondPeriodToBurnHeight({ bondIndex, poxInfo: p }),
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
      earlyUnlockBytes: bond.earlyUnlockBytes,
      earlyUnlockAdmin: bond.earlyUnlockAdmin,
      filledSbtc,
      capacitySats: capacitySats ?? null,
      allowlist: allowlist ?? null,
      allowlistTruncated: allowlistTruncated || undefined,
      allowanceSats: allowance ?? null,
      schedule: schedule ?? null,
    },
    () => {
      printSection(`Bond ${bondIndex}`);
      const rows: Row[] = [
        ['target rate', bps(bond.targetRateBps)],
        ['stx value ratio', `${bond.stxValueRatio} uSTX / 100 sats`],
        ['min stx ratio', bps(bond.minUstxRatioBps)],
        ['early-unlock admin', explorerLink(ctx.config, bond.earlyUnlockAdmin)],
        ['early-unlock bytes', `${bond.earlyUnlockBytes.length / 2} bytes (${bond.earlyUnlockBytes})`],
      ];
      if (capacitySats !== undefined) {
        rows.push(['capacity', sats(capacitySats)]);
        rows.push(['filled (sBTC)', `${sats(filledSbtc)} — ${percent(filledSbtc, capacitySats)} of capacity`]);
      } else {
        rows.push(['filled (sBTC)', sats(filledSbtc)]);
      }
      if (allowance !== undefined) {
        rows.push(['allowance', `${sats(allowance)} for ${explorerLink(ctx.config, allowanceAddress!)}`]);
      }
      printRows(rows);

      if (allowlist) {
        printSection(`Allowlist — ${allowlist.length} staker${allowlist.length === 1 ? '' : 's'}`);
        if (allowlist.length === 0) {
          printNote('no allowlist entries found in this contract’s events');
        } else {
          for (const e of allowlist) {
            process.stdout.write(`  ${dim('•')} ${explorerLink(ctx.config, e.staker)} ${dim('→')} ${sats(e.maxSats)}\n`);
          }
        }
        if (allowlistTruncated) {
          printNote(`event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — allowlist may be incomplete`);
        }
      }

      printSection('Schedule');
      if (schedule) {
        printRows([
          ['status', schedule.status],
          ['first reward cycle', schedule.firstRewardCycle],
          ['open Bitcoin block height', schedule.openBitcoinBlockHeight],
          ['L1 unlock height', schedule.l1UnlockHeight],
        ]);
      } else {
        printNote('unavailable — set POX5_FIRST_POX5_CYCLE / --first-pox5-cycle to derive');
      }
    },
  );
}

async function scanBondAllowlist(
  ctx: Ctx,
  bondIndex: number,
): Promise<{ entries: AllowlistEntry[]; truncated: boolean }> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const byStaker = new Map<string, bigint>();
  let offset = 0;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as { results?: { contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      const e = allowlistFromEventHex(ev.contract_log?.value?.hex, bondIndex);
      if (e && !byStaker.has(e.staker)) byStaker.set(e.staker, e.maxSats);
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) {
      return { entries: sortBySats(byStaker), truncated: false };
    }
  }
  return { entries: sortBySats(byStaker), truncated: true };
}

function allowlistFromEventHex(hex: string | undefined, bondIndex: number): AllowlistEntry | undefined {
  if (!hex) return undefined;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return undefined;
  }
  if (cv.type !== ClarityType.Tuple) return undefined;
  const f = (cv as { value: Record<string, ClarityValue> }).value;
  if (!f['topic'] || cvToValue(f['topic']) !== 'add-to-allowlist') return undefined;
  if (Number((f['bond-index']! as { value: bigint }).value) !== bondIndex) return undefined;
  return {
    staker: cvToValue(f['staker']!) as string,
    maxSats: (f['max-sats']! as { value: bigint }).value,
  };
}

function sortBySats(byStaker: Map<string, bigint>): AllowlistEntry[] {
  return [...byStaker.entries()]
    .map(([staker, maxSats]) => ({ staker, maxSats }))
    .sort((a, b) => (b.maxSats > a.maxSats ? 1 : b.maxSats < a.maxSats ? -1 : a.staker.localeCompare(b.staker)));
}
