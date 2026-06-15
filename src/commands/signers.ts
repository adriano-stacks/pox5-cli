import {
  fetchPoxInfo,
  fetchSignerInfo,
  fetchSignerSharesStakedForCycle,
  fetchTotalSharesStakedForCycle,
  fetchTotalUstxStacked,
} from '@stacks/bitcoin-staking';
import { Cl, ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { callPoxReadOnly } from '../pox.js';
import { explorerLink } from '../explorer.js';
import {
  clearProgress,
  dim,
  output,
  percent,
  printNote,
  printRows,
  printSection,
  progress,
  stx,
  type Row,
} from '../output.js';

export interface SignersOpts {
  staker: string[];
  stakers: boolean;
}

interface StakerEntry {
  staker: string;
  signer: string | null;
  amountUstx: bigint | null;
}

interface SignerEntry {
  signerManager: string;
  controlledBy: string | null;
  signerKey: string | null;
  delegatedUstx: bigint;
  shares: bigint;
  stakers: StakerEntry[] | null;
}

interface ContractEvent {
  contract_log?: { value?: { hex?: string } };
}
interface EventsResponse {
  results: ContractEvent[];
}

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;
const RESOLVE_CONCURRENCY = 5;

export async function signersCommand(ctx: Ctx, cycleArg: number | undefined, opts: SignersOpts): Promise<void> {
  const pox = await fetchPoxInfo(ctx.net);
  const cycle = cycleArg ?? pox.rewardCycleId;

  const signers = await collectSignerSet(ctx, cycle);
  const [totalUstx, totalShares] = await Promise.all([
    fetchTotalUstxStacked({ rewardCycle: cycle, ...ctx.net }),
    fetchTotalSharesStakedForCycle({ rewardCycle: cycle, ...ctx.net }),
  ]);

  const complete = opts.staker.length === 0;
  let other: StakerEntry[] = [];
  let truncated = false;
  let stakersError: string | undefined;

  if (opts.stakers || opts.staker.length > 0) {
    try {
      if (opts.staker.length > 0) {
        other = attachStakers(signers, await resolveStakers(ctx, opts.staker, cycle));
      } else {
        const discovered = await discoverStakers(ctx, cycle);
        truncated = discovered.truncated;
        other = attachStakers(signers, discovered.entries);
      }
    } catch (e) {
      stakersError = (e as Error).message;
      for (const s of signers) s.stakers = null;
    } finally {
      clearProgress();
    }
  }

  output(
    ctx,
    {
      cycle,
      currentCycle: pox.rewardCycleId,
      totals: { ustxDelegated: totalUstx, shares: totalShares, signerCount: signers.length },
      signers: signers.map((s) => ({
        signerManager: s.signerManager,
        controlledBy: s.controlledBy,
        signerKey: s.signerKey,
        delegatedUstx: s.delegatedUstx,
        shares: s.shares,
        stakers: s.stakers === null ? null : s.stakers.map((x) => ({ staker: x.staker, amountUstx: x.amountUstx })),
      })),
      otherStakers: other.length ? other : undefined,
      stakerScanTruncated: truncated || undefined,
      stakerEnumerationError: stakersError,
    },
    () => {
      printSection(`Signer set — cycle ${cycle}`);
      printRows([
        ['cycle', cycle === pox.rewardCycleId ? `${cycle} (current)` : cycle],
        ['signers', signers.length],
        ['total delegated', stx(totalUstx)],
        ['total shares', stx(totalShares)],
      ]);

      if (signers.length === 0) {
        printNote('no signers above the per-cycle threshold for this cycle');
      } else {
        signers.forEach((s, i) => {
          printSection(`#${i + 1}  ${explorerLink(ctx.config, s.signerManager)}`);
          const rows: Row[] = [];
          if (s.controlledBy) rows.push(['controlled by', explorerLink(ctx.config, s.controlledBy)]);
          rows.push(['signer key', s.signerKey]);
          rows.push(['delegated', `${stx(s.delegatedUstx)} (${percent(s.delegatedUstx, totalUstx)})`]);
          rows.push(['shares', stx(s.shares)]);
          printRows(rows);
          printSignerStakers(ctx, s.stakers, complete);
        });
      }

      if (other.length > 0) {
        printSection('Other stakers');
        for (const st of other) {
          const right =
            st.signer === null
              ? dim('no membership this cycle')
              : `→ ${explorerLink(ctx.config, st.signer)}  (${stx(st.amountUstx!)})`;
          process.stdout.write(`  ${explorerLink(ctx.config, st.staker)}  ${right}\n`);
        }
      }

      if (stakersError) printNote(`staker enumeration unavailable: ${stakersError}`);
      else if (truncated) printNote(`staker scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — list may be incomplete`);
    },
  );
}

async function collectSignerSet(ctx: Ctx, cycle: number): Promise<SignerEntry[]> {
  const entries: SignerEntry[] = [];
  const seen = new Set<string>();
  let signer = unwrapOptional(await callPoxReadOnly(ctx, 'get-signer-set-first-item-for-cycle', [Cl.uint(cycle)]));

  while (signer) {
    const principal = cvToValue(signer) as string;
    if (seen.has(principal)) break;
    seen.add(principal);

    const [delegatedCv, info, shares, nextCv] = await Promise.all([
      callPoxReadOnly(ctx, 'get-amount-delegated-for-signer', [Cl.principal(principal), Cl.uint(cycle)]),
      fetchSignerInfo({ signerManager: principal, ...ctx.net }),
      fetchSignerSharesStakedForCycle({ signerManager: principal, rewardCycle: cycle, ...ctx.net }),
      callPoxReadOnly(ctx, 'get-signer-set-next-item-for-cycle', [Cl.principal(principal), Cl.uint(cycle)]),
    ]);

    entries.push({
      signerManager: principal,
      controlledBy: contractIssuer(principal),
      signerKey: info?.signerKey ?? null,
      delegatedUstx: (delegatedCv as { value: bigint }).value,
      shares,
      stakers: null,
    });
    signer = unwrapOptional(nextCv);
  }
  return entries;
}

async function discoverStakers(ctx: Ctx, cycle: number): Promise<{ entries: StakerEntry[]; truncated: boolean }> {
  const { principals, truncated } = await stakerPrincipalsFromEvents(ctx);
  const resolved = await resolveStakers(ctx, principals, cycle);
  return { entries: resolved.filter((e) => e.signer !== null), truncated };
}

async function resolveStakers(ctx: Ctx, principals: string[], cycle: number): Promise<StakerEntry[]> {
  let done = 0;
  return mapLimit(principals, RESOLVE_CONCURRENCY, async (s) => {
    const entry = await resolveStaker(ctx, s, cycle);
    progress(`resolving stakers… ${++done}/${principals.length}`);
    return entry;
  });
}

async function stakerPrincipalsFromEvents(ctx: Ctx): Promise<{ principals: string[]; truncated: boolean }> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const found = new Set<string>();
  let offset = 0;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    progress(`scanning pox-5 events… page ${page + 1} (${found.size} stakers)`);
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as EventsResponse).results ?? [];
    for (const ev of results) {
      const staker = stakerFromEventHex(ev.contract_log?.value?.hex);
      if (staker) found.add(staker);
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) return { principals: [...found], truncated: false };
  }
  return { principals: [...found], truncated: true };
}

function stakerFromEventHex(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return undefined;
  }
  if (cv.type !== ClarityType.Tuple) return undefined;
  const field = (cv as { value: Record<string, ClarityValue> }).value['staker'];
  return field ? (cvToValue(field) as string) : undefined;
}

async function resolveStaker(ctx: Ctx, staker: string, cycle: number): Promise<StakerEntry> {
  const membership = unwrapOptional(
    await callPoxReadOnly(ctx, 'get-signer-cycle-membership', [Cl.principal(staker), Cl.uint(cycle)]),
  );
  if (!membership) return { staker, signer: null, amountUstx: null };
  const tuple = (membership as { value: Record<string, ClarityValue> }).value;
  return {
    staker,
    signer: cvToValue(tuple['signer']!) as string,
    amountUstx: (tuple['amount-ustx'] as { value: bigint }).value,
  };
}

function attachStakers(signers: SignerEntry[], stakers: StakerEntry[]): StakerEntry[] {
  const bySigner = new Map<string, StakerEntry[]>();
  for (const s of signers) {
    s.stakers = [];
    bySigner.set(s.signerManager, s.stakers);
  }
  const other: StakerEntry[] = [];
  for (const st of stakers) {
    const bucket = st.signer ? bySigner.get(st.signer) : undefined;
    if (bucket) bucket.push(st);
    else other.push(st);
  }
  return other;
}

function printSignerStakers(ctx: Ctx, stakers: StakerEntry[] | null, complete: boolean): void {
  if (stakers === null) return;
  if (stakers.length === 0) {
    if (complete) printNote('stakers: none delegating this cycle');
    return;
  }
  process.stdout.write(dim(`  stakers (${stakers.length}):\n`));
  for (const st of stakers) {
    process.stdout.write(`    ${explorerLink(ctx.config, st.staker)}  ${stx(st.amountUstx!)}\n`);
  }
}

function contractIssuer(principal: string): string | null {
  const dot = principal.indexOf('.');
  return dot === -1 ? null : principal.slice(0, dot);
}

function unwrapOptional(cv: ClarityValue): ClarityValue | undefined {
  return cv.type === ClarityType.OptionalNone ? undefined : (cv as { value: ClarityValue }).value;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return results;
}
