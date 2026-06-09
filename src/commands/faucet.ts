import type { Ctx } from '../context.js';
import { resolveBtcAddress, resolveStxAddress } from '../address.js';
import { bitcoinAddressLink, bitcoinTxLink, explorerLink, explorerTxLink } from '../explorer.js';
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

export interface FaucetStxOpts {
  stacking?: boolean;
}

export async function faucetStxCommand(ctx: Ctx, addressArg?: string, opts: FaucetStxOpts = {}): Promise<void> {
  const address = resolveStxAddress(ctx, addressArg);
  const params = new URLSearchParams({ address });
  if (opts.stacking) params.set('stacking', 'true');

  const body = await postFaucet(`${ctx.config.extendedApiUrl}/v1/faucets/stx?${params.toString()}`);
  const txid = (body.txId ?? body.txid) as string | undefined;
  output(ctx, { stacking: opts.stacking === true, ...body }, () => {
    printSection(`STX faucet — ${explorerLink(ctx.config, address)}`);
    printRows([
      ['mode', opts.stacking ? 'stacking (min_amount_ustx + 20%)' : 'standard (500 STX)'],
      ['success', body.success ?? true],
      ['txid', txid ? explorerTxLink(ctx.config, txid) : null],
    ]);
  });
}

export interface FaucetBtcOpts {
  large?: boolean;
  xlarge?: boolean;
}

export async function faucetBtcCommand(ctx: Ctx, addressArg: string | undefined, opts: FaucetBtcOpts): Promise<void> {
  const address = resolveBtcAddress(ctx, addressArg);
  const params = new URLSearchParams({ address });
  if (opts.xlarge) params.set('xlarge', 'true');
  else if (opts.large) params.set('large', 'true');
  const tier = opts.xlarge ? '0.5 BTC' : opts.large ? '0.01 BTC' : '0.0001 BTC';

  const body = await postFaucet(`${ctx.config.extendedApiUrl}/v1/faucets/btc?${params.toString()}`);
  const txid = (body.txid ?? body.txId) as string | undefined;
  output(ctx, { tier, ...body }, () => {
    printSection(`BTC faucet — ${bitcoinAddressLink(ctx.config, address)}`);
    printRows([
      ['tier', tier],
      ['success', body.success ?? true],
      ['txid', txid ? bitcoinTxLink(ctx.config, txid) : null],
    ]);
  });
}
