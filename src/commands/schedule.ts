import {
  bondPhaseRanges,
  fetchBondL1UnlockHeight,
  fetchPoxInfo,
  isBondActiveAtHeight,
  isInPreparePhase,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { output, printRows, printSection } from '../output.js';

export async function scheduleCommand(ctx: Ctx, bondIndex: number): Promise<void> {
  const raw = await fetchPoxInfo(ctx.net);
  const pox = requirePoxWithBondCycle(ctx, raw);
  const now = raw.currentBurnchainBlockHeight;

  const ranges = bondPhaseRanges({ bondIndex, poxInfo: pox });
  const l1Unlock = await fetchBondL1UnlockHeight({ bondIndex, ...ctx.net });
  const active = isBondActiveAtHeight({ bondIndex, burnHeight: now, poxInfo: pox });
  const inPrepare = isInPreparePhase({ burnHeight: now, poxInfo: pox });

  const phases = ranges.map((r) => ({
    name: r.name,
    startBitcoinBlockHeight: r.startBurnHeight,
    endBitcoinBlockHeight: r.endBurnHeight,
    lengthBlocks: r.length,
    blocksUntilStart: Math.max(0, r.startBurnHeight - now),
  }));

  output(
    ctx,
    {
      bondIndex,
      currentBitcoinBlockHeight: now,
      isActiveNow: active,
      inPreparePhase: inPrepare,
      l1UnlockHeight: l1Unlock,
      phases,
    },
    () => {
      printSection(`Bond ${bondIndex} schedule`);
      printRows([
        ['current Bitcoin block height', now],
        ['active now', active],
        ['in prepare phase', inPrepare],
        ['L1 unlock height', l1Unlock],
      ]);

      printSection('Phases (Bitcoin block height)');
      const width = phases.reduce((m, p) => Math.max(m, p.name.length), 0);
      for (const p of phases) {
        const until = p.blocksUntilStart > 0 ? `  (in ${p.blocksUntilStart} Bitcoin blocks)` : '';
        process.stdout.write(
          `  ${p.name.padEnd(width)}  ${p.startBitcoinBlockHeight} → ${p.endBitcoinBlockHeight}  [${p.lengthBlocks} Bitcoin blocks]${until}\n`,
        );
      }
    },
  );
}
