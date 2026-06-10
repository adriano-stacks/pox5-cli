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

export function resolveStxPrivateKey(): string {
  const key = process.env.POX5_STX_PRIVATE_KEY;
  if (!key) throw new CliError('POX5_STX_PRIVATE_KEY is not set — needed to sign the stake transaction');
  return key;
}

export function resolveBondAdminPrivateKey(): string {
  const key = process.env.POX5_BOND_ADMIN_PRIVATE_KEY || process.env.POX5_STX_PRIVATE_KEY;
  if (!key) {
    throw new CliError(
      'no admin key set — set POX5_BOND_ADMIN_PRIVATE_KEY (or POX5_STX_PRIVATE_KEY) to sign the setup-bond transaction',
    );
  }
  return key;
}

export function resolveSignerPrivateKey(): string {
  const key = process.env.POX5_SIGNER_PRIVATE_KEY || process.env.POX5_STX_PRIVATE_KEY;
  if (!key) {
    throw new CliError(
      'no signer key set — set POX5_SIGNER_PRIVATE_KEY (or POX5_STX_PRIVATE_KEY) to sign the signer-key grant',
    );
  }
  return key;
}
