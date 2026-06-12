import { TransactionSigner, broadcastTransaction, type StacksTransactionWire } from '@stacks/transactions';
import type { Ctx } from './context.js';
import { CliError } from './errors.js';
import { clearProgress, progress } from './output.js';

export interface TxOutcome {
  status: string;
  resultRepr?: string;
  aborted: boolean;
  pending: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Sign, broadcast (throwing on mempool rejection), then wait for the on-chain result.
export async function signAndConfirm(
  ctx: Ctx,
  tx: StacksTransactionWire,
  privateKey: string,
): Promise<{ txid: string; outcome: TxOutcome }> {
  const signer = new TransactionSigner(tx);
  signer.signOrigin(privateKey);
  const result = (await broadcastTransaction({ transaction: signer.getTxInComplete(), ...ctx.net })) as {
    txid?: string;
    error?: string;
    reason?: string;
  };
  if (result.error) throw new CliError(`broadcast rejected: ${result.reason ?? result.error}`);
  const txid = result.txid!;
  const outcome = await confirmTx(ctx, txid);
  return { txid, outcome };
}

export async function confirmTx(
  ctx: Ctx,
  txid: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TxOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let waited = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ctx.config.extendedApiUrl}/v1/tx/${txid}`);
      if (res.ok) {
        const tx = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
        const status = tx.tx_status;
        if (status && status !== 'pending') {
          if (waited) clearProgress();
          return { status, resultRepr: tx.tx_result?.repr, aborted: status.startsWith('abort'), pending: false };
        }
      }
    } catch {
      // transient network/indexing error — keep polling
    }
    progress(`waiting for ${txid.slice(0, 12)}… to confirm`);
    waited = true;
    await sleep(intervalMs);
  }

  if (waited) clearProgress();
  return { status: 'pending', aborted: false, pending: true };
}

export function txStatusLabel(o: TxOutcome): string {
  if (o.pending) return 'pending (timed out waiting for confirmation)';
  if (o.status === 'success') return 'success';
  if (o.status === 'abort_by_response') return `aborted — contract returned ${o.resultRepr ?? '(err)'}`;
  if (o.status === 'abort_by_post_condition') return 'aborted — post-condition failed';
  return o.status;
}
