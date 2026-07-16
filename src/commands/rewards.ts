import { fetchEarned, fetchPoxInfo } from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxAddress } from '../address.js';
import { explorerLink } from '../explorer.js';
import { resolveFirstPox5Cycle } from '../pox.js';
import { projectPendingRewards } from '../projection.js';
import { dim, output, printLegend, printNote, printRows, printSection, sats } from '../output.js';

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;
const READ_CONCURRENCY = 10;

export interface RewardsOpts {
  cycle?: number;
  bond?: number;
}

interface ClaimScan {
  claimed: Map<string, bigint>;
  bondIndices: Set<number>;
  cyclesSeen: Set<number>;
  truncated: boolean;
}

interface RewardRow {
  cycle: number;
  bondIndex?: number;
  claimable: bigint;
  claimed: bigint;
  pending: bigint;
}

function legKey(cycle: number, bondIndex?: number): string {
  return `${cycle}:${bondIndex === undefined ? 'stx' : bondIndex}`;
}

function legLabel(bondIndex?: number): string {
  return bondIndex === undefined ? 'STX-only' : `bond ${bondIndex}`;
}

export async function rewardsCommand(ctx: Ctx, signerManagerArg: string | undefined, opts: RewardsOpts): Promise<void> {
  const signerManager = signerManagerArg ?? `${resolveStxAddress(ctx)}.signer-manager`;

  const pox = await fetchPoxInfo(ctx.net);
  const [scan, projection] = await Promise.all([
    scanClaims(ctx, signerManager),
    projectPendingRewards(ctx, pox, signerManager),
  ]);
  const currentCycle = pox.rewardCycleId;
  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);

  const pendingByLeg = new Map<string, bigint>();
  for (const leg of projection.legs) {
    pendingByLeg.set(legKey(projection.cycle, leg.bondIndex), leg.pending);
    if (leg.bondIndex !== undefined) scan.bondIndices.add(leg.bondIndex);
  }

  const cycles = resolveCycles(opts, { currentCycle, firstPox5, seen: scan.cyclesSeen });
  if (opts.cycle === undefined && !cycles.includes(projection.cycle)) {
    cycles.push(projection.cycle);
    cycles.sort((a, b) => b - a);
  }
  const bondLegs: (number | undefined)[] =
    opts.bond !== undefined ? [opts.bond] : [undefined, ...[...scan.bondIndices].sort((a, b) => a - b)];

  const cells = cycles.flatMap((cycle) => bondLegs.map((bondIndex) => ({ cycle, bondIndex })));
  const grid = await mapLimit(cells, READ_CONCURRENCY, async ({ cycle, bondIndex }): Promise<RewardRow> => {
    const claimable = await fetchEarned({ signerManager, rewardCycle: cycle, bondIndex, ...ctx.net });
    const pending = cycle === projection.cycle ? pendingByLeg.get(legKey(cycle, bondIndex)) ?? 0n : 0n;
    return { cycle, bondIndex, claimable, claimed: scan.claimed.get(legKey(cycle, bondIndex)) ?? 0n, pending };
  });

  const rows = grid
    .filter((r) => r.claimable > 0n || r.claimed > 0n || r.pending > 0n)
    .sort((a, b) => b.cycle - a.cycle || legOrder(a.bondIndex) - legOrder(b.bondIndex));

  const totalClaimable = rows.reduce((acc, r) => acc + r.claimable, 0n);
  const totalClaimed = rows.reduce((acc, r) => acc + r.claimed, 0n);
  const cyclesLabel =
    cycles.length === 1
      ? String(cycles[0])
      : `${Math.min(...cycles)}–${Math.max(...cycles)} (current ${currentCycle})`;

  const totalPending = rows.reduce((acc, r) => acc + r.pending, 0n);

  output(
    ctx,
    {
      signerManager,
      currentCycle,
      firstPox5Cycle: firstPox5 ?? null,
      totals: { pending: totalPending, claimable: totalClaimable, claimed: totalClaimed },
      gathered: projection.gross,
      pendingCycle: projection.cycle,
      rewards: rows.map((r) => ({
        cycle: r.cycle,
        bondIndex: r.bondIndex ?? null,
        leg: legLabel(r.bondIndex),
        claimable: r.claimable,
        claimed: r.claimed,
        pending: r.pending,
      })),
      truncated: scan.truncated || undefined,
    },
    () => {
      printSection(`Rewards — ${explorerLink(ctx.config, signerManager)}`);
      printRows([
        ['cycles', cyclesLabel],
        ['gathered (pool)', sats(projection.gross)],
        ['total pending', totalPending > 0n ? `~${sats(totalPending)}` : sats(0n)],
        ['total claimable', sats(totalClaimable)],
        ['total claimed', sats(totalClaimed)],
      ]);

      if (rows.length === 0) {
        printNote(`no rewards for ${signerManager} across cycles ${cyclesLabel}`);
      } else {
        printRewardTable(rows);
      }

      const legend: [string, string][] = [];
      if (projection.gross > 0n) {
        legend.push([
          'pending',
          `your projected cut of the ${sats(projection.gross)} gathered in the pool — an estimate, claimable once calculate-rewards settles cycle ${projection.cycle}${projection.nextCycle ? ' (the next distribution cycle)' : ''}`,
        ]);
      }
      legend.push(
        ['claimable', 'claimable now — pull it with `pox5 claim-rewards --cycle <n>`'],
        ['claimed', 'reconstructed from claim-rewards events'],
      );
      printLegend(legend);
      if (scan.truncated) {
        printNote(`event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — claimed history may be incomplete`);
      }
    },
  );
}

function legOrder(bondIndex?: number): number {
  return bondIndex === undefined ? -1 : bondIndex;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

function resolveCycles(
  opts: RewardsOpts,
  ctx: { currentCycle: number; firstPox5?: number; seen: Set<number> },
): number[] {
  if (opts.cycle !== undefined) return [opts.cycle];
  const hi = Math.max(ctx.currentCycle, ...ctx.seen);
  const lo = ctx.firstPox5 ?? (ctx.seen.size > 0 ? Math.min(...ctx.seen) : hi);
  const set = new Set<number>(ctx.seen);
  for (let c = lo; c <= hi; c++) set.add(c);
  return [...set].sort((a, b) => b - a);
}

function printRewardTable(rows: RewardRow[]): void {
  const header = ['cycle', 'leg', 'pending', 'claimable', 'claimed'];
  const body = rows.map((r) => [
    String(r.cycle),
    legLabel(r.bondIndex),
    r.pending > 0n ? `~${sats(r.pending)}` : '—',
    r.claimable > 0n ? sats(r.claimable) : '—',
    r.claimed > 0n ? sats(r.claimed) : '—',
  ]);
  const alignRight = [true, false, false, false, false];
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]): string =>
    ('  ' + cells.map((c, i) => (alignRight[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('   ')).replace(/\s+$/, '');
  process.stdout.write(dim(line(header)) + '\n');
  for (const row of body) process.stdout.write(line(row) + '\n');
}

async function scanClaims(ctx: Ctx, signerManager: string): Promise<ClaimScan> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const claimed = new Map<string, bigint>();
  const bondIndices = new Set<number>();
  const cyclesSeen = new Set<number>();
  let offset = 0;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as { results?: { contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      accumulate(ev.contract_log?.value?.hex, signerManager, { claimed, bondIndices, cyclesSeen });
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) return { claimed, bondIndices, cyclesSeen, truncated: false };
  }
  return { claimed, bondIndices, cyclesSeen, truncated: true };
}

function accumulate(
  hex: string | undefined,
  signerManager: string,
  acc: { claimed: Map<string, bigint>; bondIndices: Set<number>; cyclesSeen: Set<number> },
): void {
  if (!hex) return;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return;
  }
  if (cv.type !== ClarityType.Tuple) return;
  const f = (cv as { value: Record<string, ClarityValue> }).value;
  const topic = f['topic'] ? cvToValue(f['topic']) : undefined;

  // setup-bond events are protocol-global (no signer-manager field), so they can't
  // tell us which bonds this signer is on — register-for-bond events can.
  if (topic === 'register-for-bond') {
    if (!f['signer'] || cvToValue(f['signer']) !== signerManager) return;
    if (f['bond-index']) acc.bondIndices.add(Number((f['bond-index'] as { value: bigint }).value));
    return;
  }
  if (topic !== 'claim-rewards') return;
  if (!f['signer-manager'] || cvToValue(f['signer-manager']) !== signerManager) return;

  const cycle = Number((f['reward-cycle'] as { value: bigint }).value);
  acc.cyclesSeen.add(cycle);

  const stxLeg = f['stx-rewards'];
  if (stxLeg && stxLeg.type === ClarityType.Tuple) {
    addClaimed(acc.claimed, cycle, undefined, legEarned(stxLeg));
  }

  const bondList = f['bond-rewards'];
  if (bondList && bondList.type === ClarityType.List) {
    for (const item of (bondList as { value: ClarityValue[] }).value) {
      if (item.type !== ClarityType.Tuple) continue;
      const t = (item as { value: Record<string, ClarityValue> }).value;
      const bondIndex = Number((t['bond-index'] as { value: bigint }).value);
      acc.bondIndices.add(bondIndex);
      addClaimed(acc.claimed, cycle, bondIndex, (t['earned'] as { value: bigint }).value);
    }
  }
}

function legEarned(tuple: ClarityValue): bigint {
  const inner = (tuple as { value: Record<string, ClarityValue> }).value;
  return (inner['earned'] as { value: bigint }).value;
}

function addClaimed(claimed: Map<string, bigint>, cycle: number, bondIndex: number | undefined, amount: bigint): void {
  const key = legKey(cycle, bondIndex);
  claimed.set(key, (claimed.get(key) ?? 0n) + amount);
}
