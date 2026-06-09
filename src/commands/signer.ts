import {
  fetchSignerGrantMessageHash,
  fetchSignerInfo,
  fetchVerifySignerKeyGrant,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { explorerLink } from '../explorer.js';
import { output, printRows, printSection, type Row } from '../output.js';

export interface SignerOpts {
  key?: string;
  authId?: number;
}

export async function signerCommand(ctx: Ctx, signerManager: string, opts: SignerOpts): Promise<void> {
  const info = await fetchSignerInfo({ signerManager, ...ctx.net });
  const granted = opts.key
    ? await fetchVerifySignerKeyGrant({ signerKey: opts.key, signerManager, ...ctx.net })
    : undefined;
  const grantHash =
    opts.authId !== undefined
      ? await fetchSignerGrantMessageHash({ signerManager, authId: opts.authId, ...ctx.net })
      : undefined;

  output(
    ctx,
    {
      signerManager,
      signerKey: info?.signerKey ?? null,
      registered: info !== undefined,
      grantedForKey: granted ?? null,
      grantMessageHash: grantHash ?? null,
    },
    () => {
      const rows: Row[] = [
        ['registered', info !== undefined],
        ['signer key', info?.signerKey ?? null],
      ];
      if (granted !== undefined) rows.push(['grant active (for --key)', granted]);
      if (grantHash !== undefined) rows.push(['grant message hash', grantHash]);
      printSection(`Signer-manager — ${explorerLink(ctx.config, signerManager)}`);
      printRows(rows);
    },
  );
}
