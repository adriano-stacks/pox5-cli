import { fetchBond, minUstxForSatsAmount } from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { output, printRows, printSection, sats, stx } from '../output.js';

export interface QuoteOpts {
  bond: number;
  sats?: bigint;
  btc?: number;
}

export async function quoteCommand(ctx: Ctx, opts: QuoteOpts): Promise<void> {
  let satsAmount: bigint;
  if (opts.sats !== undefined) {
    satsAmount = opts.sats;
  } else if (opts.btc !== undefined) {
    satsAmount = BigInt(Math.round(opts.btc * 1e8));
  } else {
    throw new CliError('provide --sats <n> or --btc <n>');
  }

  const bond = await fetchBond({ bondIndex: opts.bond, ...ctx.net });
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);

  const requiredUstx = minUstxForSatsAmount({
    sats: satsAmount,
    stxValueRatio: bond.stxValueRatio,
    minUstxRatioBps: bond.minUstxRatioBps,
  });

  output(
    ctx,
    {
      bondIndex: opts.bond,
      sats: satsAmount,
      stxValueRatio: bond.stxValueRatio,
      minUstxRatioBps: bond.minUstxRatioBps,
      requiredUstx,
    },
    () => {
      printSection(`Ratio quote — bond ${opts.bond}`);
      printRows([
        ['BTC commitment', sats(satsAmount)],
        ['stx value ratio', `${bond.stxValueRatio} uSTX / 100 sats`],
        ['min stx ratio', `${bond.minUstxRatioBps} bps`],
        ['required STX', stx(requiredUstx)],
      ]);
    },
  );
}
