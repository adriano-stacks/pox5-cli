import { TransactionSigner, broadcastTransaction, type StacksTransactionWire } from '@stacks/transactions';
import type { Ctx } from './context.js';
import { CliError } from './errors.js';
import { explorerTxLink } from './explorer.js';
import { clearProgress, progress, type Row } from './output.js';

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

export interface TwoStepResult {
  deployTxid?: string;
  deployOutcome?: TxOutcome;
  callTxid?: string;
  callOutcome?: TxOutcome;
  skipped?: string;
}

// The deploy-then-call pattern for any command that needs two dependent transactions:
// publish a contract, WAIT for it to confirm on-chain, THEN send the call that needs it
// (so the call no longer bounces with NoSuchContract). `deployTx` is undefined when the
// contract already exists — the call is sent directly. The call is skipped (with a reason)
// if the deploy reverts or doesn't confirm in the wait window.
export async function deployThenCall(
  ctx: Ctx,
  deployTx: StacksTransactionWire | undefined,
  callTx: StacksTransactionWire,
  privateKey: string,
): Promise<TwoStepResult> {
  let deployTxid: string | undefined;
  let deployOutcome: TxOutcome | undefined;
  if (deployTx) {
    const r = await signAndConfirm(ctx, deployTx, privateKey);
    deployTxid = r.txid;
    deployOutcome = r.outcome;
    if (deployOutcome.aborted) {
      return { deployTxid, deployOutcome, skipped: `deploy reverted on-chain (${txStatusLabel(deployOutcome)})` };
    }
    if (deployOutcome.pending) {
      return { deployTxid, deployOutcome, skipped: 'deploy did not confirm within the wait window — re-run to send the follow-up once it lands' };
    }
  }
  try {
    const r = await signAndConfirm(ctx, callTx, privateKey);
    return { deployTxid, deployOutcome, callTxid: r.txid, callOutcome: r.outcome };
  } catch (e) {
    if (!deployTxid) throw e;
    return { deployTxid, deployOutcome, skipped: `the follow-up was not accepted (${(e as Error).message}) — re-run to retry` };
  }
}

export function twoStepSucceeded(r: TwoStepResult): boolean {
  return r.callOutcome !== undefined && !r.callOutcome.aborted && !r.callOutcome.pending;
}

export function twoStepRows(ctx: Ctx, r: TwoStepResult, labels: { deploy: string; call: string }): Row[] {
  const rows: Row[] = [];
  if (r.deployTxid) rows.push([`${labels.deploy} txid`, explorerTxLink(ctx.config, r.deployTxid)]);
  if (r.deployOutcome) rows.push([`${labels.deploy} result`, txStatusLabel(r.deployOutcome)]);
  if (r.callTxid) rows.push([`${labels.call} txid`, explorerTxLink(ctx.config, r.callTxid)]);
  if (r.callOutcome) rows.push([`${labels.call} result`, txStatusLabel(r.callOutcome)]);
  return rows;
}

export function twoStepNotes(r: TwoStepResult, labels: { call: string }): string[] {
  const notes: string[] = [];
  if (r.skipped) notes.push(r.skipped);
  if (r.callOutcome?.aborted) notes.push(`${labels.call} reverted on-chain — it did not take effect`);
  return notes;
}

export function twoStepAborted(r: TwoStepResult): boolean {
  return r.deployOutcome?.aborted === true || r.callOutcome?.aborted === true;
}
