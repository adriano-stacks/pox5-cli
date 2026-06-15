import { buildUnstakeSbtc, fetchBondMembership } from '@stacks/bitcoin-staking';
import {
  Pc,
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchSbtcBalance, fetchSbtcContractId } from '../pox.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { output, printNote, printRows, printSection, sbtc, stx, type Row } from '../output.js';

export interface UnstakeSbtcOpts {
  amountSats: bigint;
  signerManager?: string;
  fee: bigint;
  broadcast: boolean;
}

export async function unstakeSbtcCommand(ctx: Ctx, opts: UnstakeSbtcOpts): Promise<void> {
  if (opts.amountSats <= 0n) throw new CliError('unstake amount must be positive');

  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const [membership, sbtcInfo, nonce] = await Promise.all([
    fetchBondMembership({ address: sender, ...ctx.net }),
    fetchSbtcBalance(ctx, sender),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);

  if (!membership) {
    throw new CliError(`${sender} has no active bond membership — nothing staked to withdraw (ERR_NOT_BOND_PARTICIPANT u34)`);
  }
  if (membership.isL1Lock) {
    throw new CliError(
      `bond ${membership.bondIndex} membership is a native-BTC (L1) lock — unstake-sbtc only applies to sBTC stakes (ERR_CANNOT_UNSTAKE_SBTC u38); use early-exit for L1`,
    );
  }

  const signerManager = opts.signerManager ?? membership.signer;
  const sbtcContractId = sbtcInfo?.contractId ?? (await fetchSbtcContractId(ctx));
  if (!sbtcContractId) {
    throw new CliError(
      'could not resolve the sBTC token contract from pox-5 source — cannot build the sBTC transfer post-condition',
    );
  }
  const sbtcBalance = sbtcInfo?.balance;
  const remaining = membership.amountSats > opts.amountSats ? membership.amountSats - opts.amountSats : 0n;

  const postConditions = [
    Pc.principal(`${ctx.net.network.bootAddress}.pox-5` as `${string}.${string}`)
      .willSendLte(opts.amountSats)
      .ft(sbtcContractId as `${string}.${string}`, 'sbtc-token'),
  ];
  const tx = await buildUnstakeSbtc({
    signerManager,
    amountToWithdrawSats: opts.amountSats,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
    postConditions,
    postConditionMode: 'deny',
  });

  const baseRows: Row[] = [
    ['staker', explorerLink(ctx.config, sender)],
    ['bond', membership.bondIndex],
    ['signer-manager', explorerLink(ctx.config, signerManager)],
    ['currently staked', sbtc(membership.amountSats)],
    ['withdraw', sbtc(opts.amountSats)],
    ['remaining staked', sbtc(remaining)],
    ['sBTC token', explorerLink(ctx.config, sbtcContractId)],
    ['sBTC balance', sbtcBalance !== undefined ? `${sbtc(sbtcBalance)} → ${sbtc(sbtcBalance + opts.amountSats)}` : null],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const blockers: string[] = [];
  if (opts.amountSats > membership.amountSats) {
    blockers.push(
      `withdraw ${opts.amountSats} sats exceeds the ${membership.amountSats} sats staked (ERR_INVALID_UNSTAKE_SBTC_AMOUNT u37)`,
    );
  }
  if (signerManager !== membership.signer) {
    blockers.push(
      `--signer-manager ${signerManager} does not match the membership signer ${membership.signer} (ERR_INVALID_OLD_SIGNER_MANAGER u36)`,
    );
  }

  const json = {
    staker: sender,
    bondIndex: membership.bondIndex,
    signerManager,
    stakedSats: membership.amountSats,
    withdrawSats: opts.amountSats,
    remainingSats: remaining,
    sbtcToken: sbtcContractId,
    sbtcBalance: sbtcBalance ?? null,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Unstake sBTC from bond ${membership.bondIndex} (dry run)`);
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`unstake would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection(`Unstake sBTC from bond ${membership.bondIndex}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) printNote('the transaction reverted on-chain — no sBTC was withdrawn');
    else if (outcome.pending) printNote('still pending — re-check the explorer link or pox5 position');
    else printNote(`the contract released ${sbtc(opts.amountSats)} to your wallet; ${sbtc(remaining)} stays staked`);
  });
  if (outcome.aborted) process.exitCode = 1;
}
