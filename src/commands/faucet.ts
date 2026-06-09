import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { output, printRows, printSection } from '../output.js';

async function postFaucet(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new CliError(`faucet request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new CliError(`faucet returned ${res.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function faucetStxCommand(ctx: Ctx, address: string): Promise<void> {
  const body = await postFaucet(
    `${ctx.config.extendedApiUrl}/v1/faucets/stx?address=${encodeURIComponent(address)}`,
  );
  output(ctx, body, () => {
    printSection(`STX faucet — ${address}`);
    printRows([
      ['success', body.success ?? true],
      ['txid', body.txId ?? body.txid ?? null],
    ]);
  });
}

export interface FaucetBtcOpts {
  large?: boolean;
  xlarge?: boolean;
}

export async function faucetBtcCommand(ctx: Ctx, address: string, opts: FaucetBtcOpts): Promise<void> {
  const params = new URLSearchParams({ address });
  if (opts.xlarge) params.set('xlarge', 'true');
  else if (opts.large) params.set('large', 'true');
  const tier = opts.xlarge ? '0.5 BTC' : opts.large ? '0.01 BTC' : '0.0001 BTC';

  const body = await postFaucet(`${ctx.config.extendedApiUrl}/v1/faucets/btc?${params.toString()}`);
  output(ctx, { tier, ...body }, () => {
    printSection(`BTC faucet — ${address}`);
    printRows([
      ['tier', tier],
      ['success', body.success ?? true],
      ['txid', body.txid ?? body.txId ?? null],
    ]);
  });
}
