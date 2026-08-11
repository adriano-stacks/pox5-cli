import {
  bondPhaseRanges,
  bondStatus,
  fetchBondL1UnlockHeight,
  fetchPoxInfo,
  fetchProtocolBond,
  isBondActiveAtHeight,
} from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { bitcoinBlocks, bold, output, printNote, printRows, printSection } from '../output.js';
import { fetchIndexedBond } from '../staking-api.js';

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;

interface PhaseDef {
  name: string;
  start: number;
  end: number;
  point?: boolean;
}

export async function scheduleCommand(ctx: Ctx, bondIndex: number): Promise<void> {
  const raw = await fetchPoxInfo(ctx.net);
  const pox = requirePoxWithBondCycle(ctx, raw);
  const now = raw.currentBurnchainBlockHeight;

  const ranges = bondPhaseRanges({ bondIndex, poxInfo: pox });
  const setupWindowOpen = ranges[0]!.startBurnHeight;

  const indexed = await fetchIndexedBond(ctx, bondIndex);
  const [l1Unlock, announced, isBondSetup] = indexed
    ? [BigInt(indexed.schedule.unlock.bitcoin_height), indexed.transaction?.bitcoin_block.height, true] as const
    : await Promise.all([
        fetchBondL1UnlockHeight({ bondIndex, ...ctx.net }),
        fetchAnnouncementHeight(ctx, bondIndex),
        fetchProtocolBond({ bondIndex, ...ctx.net }).then((bond) => bond !== undefined),
      ]);
  const currentPhase = bondStatus({ bondIndex, poxInfo: pox, isBondSetup });
  const active =
    isBondSetup && isBondActiveAtHeight({ bondIndex, burnHeight: now, poxInfo: pox });
  const announceHeight = announced ?? setupWindowOpen;

  const defs: PhaseDef[] = [
    { name: 'announced', start: announceHeight, end: announceHeight, point: true },
    ...ranges.map((range) => ({
      name: range.name,
      start: range.name === 'open' ? Math.max(announceHeight, range.startBurnHeight) : range.startBurnHeight,
      end: range.endBurnHeight,
    })),
  ];

  const phases = defs.map((d) => {
    const isPoint = d.point === true;
    return {
      name: d.name,
      startBitcoinBlockHeight: d.start,
      endBitcoinBlockHeight: isPoint ? null : d.end,
      lengthBlocks: isPoint ? null : d.end - d.start,
      blocksUntilStart: Math.max(0, d.start - now),
      current: !isPoint && d.name === currentPhase,
    };
  });

  output(
    ctx,
    {
      bondIndex,
      currentBitcoinBlockHeight: now,
      currentPhase: currentPhase ?? null,
      announcedAtHeight: announced ?? null,
      isActiveNow: active,
      l1UnlockHeight: l1Unlock,
      phases,
    },
    () => {
      printSection(`Bond ${bondIndex} schedule`);
      printRows([
        ['current Bitcoin block height', now],
        ['current phase', currentPhase ?? null],
        ['active now', active],
        ['L1 unlock height', l1Unlock],
      ]);

      printSection('Phases (Bitcoin block height)');
      const width = phases.reduce((m, p) => Math.max(m, p.name.length), 0);
      for (const p of phases) {
        const note = p.current
          ? `  ${bold('← now')}`
          : p.blocksUntilStart > 0
            ? `  (in ${bitcoinBlocks(p.blocksUntilStart)})`
            : '';
        const span =
          p.lengthBlocks === null
            ? `at ${p.startBitcoinBlockHeight}`
            : `${p.startBitcoinBlockHeight} → ${p.endBitcoinBlockHeight}  [${bitcoinBlocks(p.lengthBlocks)}]`;
        process.stdout.write(`  ${p.name.padEnd(width)}  ${span}${note}\n`);
      }

      if (announced === undefined) {
        printNote(
          `announcement block unknown (bond not set up yet, or events unavailable) — ` +
            `“announced”/“open” are projected from the earliest setup height ${setupWindowOpen}`,
        );
      }
    },
  );
}

async function fetchAnnouncementHeight(ctx: Ctx, bondIndex: number): Promise<number | undefined> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  for (let page = 0, offset = 0; page < EVENT_MAX_PAGES; page++, offset += EVENT_PAGE_SIZE) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    const results =
      ((await res.json()) as { results?: { tx_id?: string; contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      if (ev.tx_id && isSetupBondFor(ev.contract_log?.value?.hex, bondIndex)) {
        return fetchTxBurnHeight(ctx, ev.tx_id);
      }
    }
    if (results.length < EVENT_PAGE_SIZE) return undefined;
  }
  return undefined;
}

function isSetupBondFor(hex: string | undefined, bondIndex: number): boolean {
  if (!hex) return false;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return false;
  }
  if (cv.type !== ClarityType.Tuple) return false;
  const f = (cv as { value: Record<string, ClarityValue> }).value;
  if (!f['topic'] || cvToValue(f['topic']) !== 'setup-bond') return false;
  const idx = f['bond-index'];
  return idx !== undefined && Number((idx as { value: bigint }).value) === bondIndex;
}

async function fetchTxBurnHeight(ctx: Ctx, txId: string): Promise<number | undefined> {
  let res: Response;
  try {
    res = await fetch(`${ctx.config.extendedApiUrl}/v1/tx/${txId}`);
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const tx = (await res.json()) as { burn_block_height?: number };
  return typeof tx.burn_block_height === 'number' ? tx.burn_block_height : undefined;
}
