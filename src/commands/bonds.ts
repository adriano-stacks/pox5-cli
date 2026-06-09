import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { dim, output, printNote, printSection } from '../output.js';

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;

interface BondRecord {
  bondIndex: number;
  firstRewardCycle: number;
  bondStartHeight: number;
  targetRateBps: number;
  stxValueRatio: bigint;
  minUstxRatioBps: number;
  earlyUnlockAdmin: string;
}

export async function bondsCommand(ctx: Ctx): Promise<void> {
  const { bonds, truncated } = await scanSetupBondEvents(ctx);

  output(
    ctx,
    { count: bonds.length, bonds, truncated: truncated || undefined },
    () => {
      printSection(`Bonds — ${bonds.length} issued`);
      if (bonds.length === 0) {
        printNote('no bonds have been set up on this contract');
        return;
      }

      const header = ['idx', 'first cycle', 'start (BTC)', 'target', 'ratio (uSTX/100sat)'];
      const rows = bonds.map((b) => [
        String(b.bondIndex),
        String(b.firstRewardCycle),
        String(b.bondStartHeight),
        `${(b.targetRateBps / 100).toFixed(2)}%`,
        String(b.stxValueRatio),
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
      const line = (cells: string[]): string => '  ' + cells.map((c, i) => c.padStart(widths[i]!)).join('   ');

      process.stdout.write(dim(line(header)) + '\n');
      for (const r of rows) process.stdout.write(line(r) + '\n');

      if (truncated) {
        printNote(`event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — list may be incomplete`);
      }
    },
  );
}

async function scanSetupBondEvents(ctx: Ctx): Promise<{ bonds: BondRecord[]; truncated: boolean }> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const byIndex = new Map<number, BondRecord>();
  let offset = 0;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as { results?: { contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      const rec = bondFromEventHex(ev.contract_log?.value?.hex);
      if (rec && !byIndex.has(rec.bondIndex)) byIndex.set(rec.bondIndex, rec);
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) {
      return { bonds: sortByIndex(byIndex), truncated: false };
    }
  }
  return { bonds: sortByIndex(byIndex), truncated: true };
}

function bondFromEventHex(hex: string | undefined): BondRecord | undefined {
  if (!hex) return undefined;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return undefined;
  }
  if (cv.type !== ClarityType.Tuple) return undefined;
  const f = (cv as { value: Record<string, ClarityValue> }).value;
  if (!f['topic'] || cvToValue(f['topic']) !== 'setup-bond') return undefined;
  return {
    bondIndex: Number((f['bond-index']! as { value: bigint }).value),
    firstRewardCycle: Number((f['first-reward-cycle']! as { value: bigint }).value),
    bondStartHeight: Number((f['bond-start-height']! as { value: bigint }).value),
    targetRateBps: Number((f['target-rate']! as { value: bigint }).value),
    stxValueRatio: (f['stx-value-ratio']! as { value: bigint }).value,
    minUstxRatioBps: Number((f['min-ustx-ratio']! as { value: bigint }).value),
    earlyUnlockAdmin: cvToValue(f['early-unlock-admin']!) as string,
  };
}

function sortByIndex(byIndex: Map<number, BondRecord>): BondRecord[] {
  return [...byIndex.values()].sort((a, b) => a.bondIndex - b.bondIndex);
}
