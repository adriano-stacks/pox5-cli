import {
  fetchSignerGrantMessageHash,
  fetchSignerInfo,
  fetchVerifySignerKeyGrant,
} from '@stacks/bitcoin-staking';
import type { Ctx } from '../context.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { output, printRows, printSection, type Row } from '../output.js';
import { fetchIndexedSigner } from '../staking-api.js';

export interface SignerOpts {
  key?: string;
  authId?: number;
}

export async function signerCommand(ctx: Ctx, signerManager: string, opts: SignerOpts): Promise<void> {
  const indexed = await fetchIndexedSigner(ctx, signerManager);
  const info = indexed
    ? { signerKey: indexed.signer_key.replace(/^0x/, '') }
    : await fetchSignerInfo({ signerManager, ...ctx.net });
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
      registrationTxid: indexed?.transaction?.tx_id ?? null,
      grantedForKey: granted ?? null,
      grantMessageHash: grantHash ?? null,
    },
    () => {
      const rows: Row[] = [
        ['registered', info !== undefined],
        ['signer key', info?.signerKey ?? null],
      ];
      if (indexed?.transaction) {
        rows.push(['registration txid', explorerTxLink(ctx.config, indexed.transaction.tx_id)]);
        rows.push(['registered at Bitcoin block', indexed.transaction.bitcoin_block.height]);
      }
      if (granted !== undefined) rows.push(['grant active (for --key)', granted]);
      if (grantHash !== undefined) rows.push(['grant message hash', grantHash]);
      printSection(`Signer-manager — ${explorerLink(ctx.config, signerManager)}`);
      printRows(rows);
    },
  );
}
