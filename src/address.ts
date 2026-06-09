import type { Ctx } from './context.js';
import { CliError } from './errors.js';

export function resolveStxAddress(ctx: Ctx, arg?: string): string {
  const address = arg ?? ctx.config.stxAddress;
  if (!address) throw new CliError('no STX address given and POX5_STX_ADDRESS is not set');
  return address;
}

export function resolveBtcAddress(ctx: Ctx, arg?: string): string {
  const address = arg ?? ctx.config.btcAddress;
  if (!address) throw new CliError('no BTC address given and POX5_BTC_ADDRESS is not set');
  return address;
}
