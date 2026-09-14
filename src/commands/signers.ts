import {
  fetchAmountDelegatedForSigner,
  fetchPoxInfo,
  fetchSignerCycleMembership,
  fetchSignerInfo,
  fetchSignerSetFirstItem,
  fetchSignerSetNextItem,
  fetchSignerSharesStakedForCycle,
  fetchTotalSharesStakedForCycle,
  fetchTotalUstxStacked,
} from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
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
import {
  fetchIndexedCurrentCycleSigners,
  fetchIndexedSignerStakers,
  type IndexedCycleSignerManager,
} from '../staking-api.js';

export interface SignersOpts {
  staker: string[];
  stakers: boolean;
}

interface StakerEntry {
  staker: string;
  signer: string | null;
  amountUstx: bigint | null;
}

interface SignerManagerEntry {
  signerManager: string;
  controlledBy: string | null;
  registeredAt: IndexedCycleSignerManager['registered_at'] | null;
  grantedKeys: IndexedCycleSignerManager['granted_keys'];
  grantActive: boolean | null;
  pendingKeyUpdate: IndexedCycleSignerManager['pending_key_update'];
  stakers: StakerEntry[] | null;
}

interface SignerEntry {
  signerKey: string | null;
  stackedUstx: bigint;
  stackedPercent: number | null;
  weight: number | null;
  weightPercent: number | null;
  shares: bigint | null;
  managers: SignerManagerEntry[];
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

  const signerSet = await collectSignerSet(ctx, cycle, pox.rewardCycleId);
  const signers = signerSet.entries;
  progress(`reading totals for cycle ${cycle}…`);
  let totalUstx: bigint;
  let totalShares: bigint;
  try {
    [totalUstx, totalShares] = await Promise.all([
      signerSet.indexed
        ? Promise.resolve(signers.reduce((sum, signer) => sum + signer.stackedUstx, 0n))
        : fetchTotalUstxStacked({ rewardCycle: cycle, ...ctx.net }),
      fetchTotalSharesStakedForCycle({ rewardCycle: cycle, ...ctx.net }),
    ]);
  } finally {
    clearProgress();
  }

  const complete = opts.staker.length === 0;
  let other: StakerEntry[] = [];
  let truncated = false;
  let stakersError: string | undefined;

  if (opts.stakers || opts.staker.length > 0) {
    try {
      if (opts.staker.length > 0) {
        other = attachStakers(signers, await resolveStakers(ctx, opts.staker, cycle));
      } else {
        const discovered = await discoverStakers(ctx, cycle, signers, cycle >= pox.rewardCycleId);
        truncated = discovered.truncated;
        other = attachStakers(signers, discovered.entries);
      }
    } catch (e) {
      stakersError = (e as Error).message;
      for (const signer of signers) {
        for (const manager of signer.managers) manager.stakers = null;
      }
    } finally {
      clearProgress();
    }
  }

  const totalWeight = signerSet.indexed
    ? signers.reduce((sum, signer) => sum + signer.weight!, 0)
    : null;
  const managerCount = signers.reduce((sum, signer) => sum + signer.managers.length, 0);

  output(
    ctx,
    {
      cycle,
      currentCycle: pox.rewardCycleId,
      totals: {
        ustxStacked: totalUstx,
        ustxDelegated: totalUstx,
        shares: totalShares,
        weight: totalWeight,
        signerCount: signers.length,
        managerCount,
      },
      signers: signers.map((s) => ({
        signerKey: s.signerKey,
        stackedUstx: s.stackedUstx,
        stackedPercent: s.stackedPercent,
        weight: s.weight,
        weightPercent: s.weightPercent,
        shares: s.shares,
        signerManagers: s.managers.map((manager) => ({
          signerManager: manager.signerManager,
          controlledBy: manager.controlledBy,
          registeredAt: manager.registeredAt,
          grantActive: manager.grantActive,
          grantedKeys: manager.grantedKeys,
          pendingKeyUpdate: manager.pendingKeyUpdate,
          stakers: manager.stakers === null
            ? null
            : manager.stakers.map((x) => ({ staker: x.staker, amountUstx: x.amountUstx })),
        })),
      })),
      otherStakers: other.length ? other : undefined,
      stakerScanTruncated: truncated || undefined,
      stakerEnumerationError: stakersError,
    },
    () => {
      printSection(`Signer set — cycle ${cycle}`);
      printRows([
        ['cycle', cycle === pox.rewardCycleId ? `${cycle} (current)` : cycle],
        ['signing keys', signers.length],
        ['signer managers', managerCount],
        ['total stacked', stx(totalUstx)],
        ['total reward shares', stx(totalShares)],
        ...(totalWeight === null ? [] : [['total signer weight', totalWeight] as Row]),
      ]);

      if (signers.length === 0) {
        printNote('no signers above the per-cycle threshold for this cycle');
      } else {
        signers.forEach((s, i) => {
          printSection(`#${i + 1}`);
          const rows: Row[] = [
            ['signer key', s.signerKey],
            ['stacked', `${stx(s.stackedUstx)} (${percent(s.stackedUstx, totalUstx)})`],
          ];
          if (s.weight !== null) rows.push(['signer weight', `${s.weight} (${s.weightPercent!.toFixed(2)}%)`]);
          if (s.shares !== null) rows.push(['reward shares', stx(s.shares)]);
          rows.push(['signer managers', s.managers.length]);
          for (const [managerIndex, manager] of s.managers.entries()) {
            const prefix = s.managers.length === 1 ? 'manager' : `manager ${managerIndex + 1}`;
            rows.push([prefix, explorerLink(ctx.config, manager.signerManager)]);
            if (manager.controlledBy) rows.push(['  controlled by', explorerLink(ctx.config, manager.controlledBy)]);
            if (manager.registeredAt) {
              rows.push(['  registered at', `Bitcoin block ${manager.registeredAt.bitcoin_block_height}`]);
            }
            if (manager.grantActive !== null) rows.push(['  key grant active', manager.grantActive]);
            if (manager.pendingKeyUpdate) {
              rows.push([
                '  pending key',
                `${manager.pendingKeyUpdate.signer_key.replace(/^0x/, '')} (cycle ${manager.pendingKeyUpdate.effective_cycle})`,
              ]);
            }
          }
          printRows(rows);
          for (const manager of s.managers) {
            printSignerStakers(ctx, manager, complete, s.managers.length > 1);
          }
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

async function collectSignerSet(
  ctx: Ctx,
  cycle: number,
  currentCycle: number,
): Promise<{ entries: SignerEntry[]; indexed: boolean }> {
  if (cycle === currentCycle) {
    progress(`reading the indexed signer set for cycle ${cycle}…`);
    const indexed = await fetchIndexedCurrentCycleSigners(ctx);
    if (indexed !== undefined) {
      clearProgress();
      return {
        indexed: true,
        entries: indexed.map((signer) => ({
          signerKey: signer.signing_key.replace(/^0x/, ''),
          stackedUstx: BigInt(signer.staked_stx.amount),
          stackedPercent: signer.staked_stx.percent,
          weight: signer.weight.amount,
          weightPercent: signer.weight.percent,
          shares: null,
          managers: signer.signer_managers.map(managerFromIndex),
        })),
      };
    }
  }

  const entries: SignerEntry[] = [];
  const seen = new Set<string>();
  try {
    progress('reading the signer registry…');
    progress(`reading the signer set for cycle ${cycle}…`);
    let signer = await fetchSignerSetFirstItem({ rewardCycle: cycle, ...ctx.net });

    while (signer) {
      const principal = signer;
      if (seen.has(principal)) break;
      seen.add(principal);
      progress(`reading the signer set for cycle ${cycle}… ${entries.length + 1} found`);

      const [delegatedUstx, shares, next, info] = await Promise.all([
        fetchAmountDelegatedForSigner({ signerManager: principal, rewardCycle: cycle, ...ctx.net }),
        fetchSignerSharesStakedForCycle({ signerManager: principal, rewardCycle: cycle, ...ctx.net }),
        fetchSignerSetNextItem({ signer: principal, rewardCycle: cycle, ...ctx.net }),
        fetchSignerInfo({ signerManager: principal, ...ctx.net }),
      ]);

      entries.push({
        signerKey: info?.signerKey ?? null,
        stackedUstx: delegatedUstx,
        stackedPercent: null,
        weight: null,
        weightPercent: null,
        shares,
        managers: [{
          signerManager: principal,
          controlledBy: contractIssuer(principal),
          registeredAt: null,
          grantedKeys: [],
          grantActive: null,
          pendingKeyUpdate: null,
          stakers: null,
        }],
      });
      signer = next;
    }
    return { entries, indexed: false };
  } finally {
    clearProgress();
  }
}

function managerFromIndex(manager: IndexedCycleSignerManager): SignerManagerEntry {
  return {
    signerManager: manager.signer_manager,
    controlledBy: contractIssuer(manager.signer_manager),
    registeredAt: manager.registered_at,
    grantedKeys: manager.granted_keys,
    grantActive: manager.grant_active,
    pendingKeyUpdate: manager.pending_key_update,
    stakers: null,
  };
}

async function discoverStakers(
  ctx: Ctx,
  cycle: number,
  signers: SignerEntry[],
  useIndex: boolean,
): Promise<{ entries: StakerEntry[]; truncated: boolean }> {
  const managers = signers.flatMap((signer) => signer.managers);
  let signersRead = 0;
  const indexed = useIndex
    ? await mapLimit(managers, RESOLVE_CONCURRENCY, async (manager) => {
        progress(`reading signer stakers… ${++signersRead}/${managers.length}`);
        return fetchIndexedSignerStakers(ctx, manager.signerManager);
      })
    : [];
  const indexedComplete = useIndex && indexed.every((items) => items !== undefined);
  let principals: string[];
  let truncated: boolean;
  if (indexedComplete) {
    principals = [...new Set(indexed.flatMap((items) => items!.map((item) => item.staker)))];
    truncated = false;
  } else {
    const scan = await stakerPrincipalsFromEvents(ctx);
    principals = scan.principals;
    truncated = scan.truncated;
  }
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
  const membership = await fetchSignerCycleMembership({ staker, rewardCycle: cycle, ...ctx.net });
  if (!membership) return { staker, signer: null, amountUstx: null };
  return {
    staker,
    signer: membership.signer,
    amountUstx: membership.amountUstx,
  };
}

function attachStakers(signers: SignerEntry[], stakers: StakerEntry[]): StakerEntry[] {
  const bySigner = new Map<string, StakerEntry[]>();
  for (const s of signers) {
    for (const manager of s.managers) {
      manager.stakers = [];
      bySigner.set(manager.signerManager, manager.stakers);
    }
  }
  const other: StakerEntry[] = [];
  for (const st of stakers) {
    const bucket = st.signer ? bySigner.get(st.signer) : undefined;
    if (bucket) bucket.push(st);
    else other.push(st);
  }
  return other;
}

function printSignerStakers(
  ctx: Ctx,
  manager: SignerManagerEntry,
  complete: boolean,
  labelManager: boolean,
): void {
  const stakers = manager.stakers;
  if (stakers === null) return;
  if (stakers.length === 0) {
    if (complete) {
      const via = labelManager ? ` via ${manager.signerManager}` : '';
      printNote(`stakers${via}: none delegating this cycle`);
    }
    return;
  }
  const via = labelManager ? ` via ${manager.signerManager}` : '';
  process.stdout.write(dim(`  stakers${via} (${stakers.length}):\n`));
  for (const st of stakers) {
    process.stdout.write(`    ${explorerLink(ctx.config, st.staker)}  ${stx(st.amountUstx!)}\n`);
  }
}

function contractIssuer(principal: string): string | null {
  const dot = principal.indexOf('.');
  return dot === -1 ? null : principal.slice(0, dot);
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
