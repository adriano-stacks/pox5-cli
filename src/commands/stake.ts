import {
  buildStake,
  fetchEligibleStake,
  fetchPoxInfo,
  rewardCycleToBurnHeight,
} from '@stacks/bitcoin-staking';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError, eligibilityBlockers } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { output, printNote, printRows, printSection, stx, type Row } from '../output.js';

export interface StakeOpts {
  signerManager: string;
  amountUstx: bigint;
  cycles: number;
  startHeight?: number;
  fee: bigint;
  broadcast: boolean;
}

export async function stakeCommand(ctx: Ctx, opts: StakeOpts): Promise<void> {
  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const pox = await fetchPoxInfo(ctx.net);
  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHt = opts.startHeight ?? bitcoinHeight;
  const firstRewardCycle = pox.rewardCycleId + 1;
  const firstCycleStartHeight = rewardCycleToBurnHeight({ rewardCycle: firstRewardCycle, poxInfo: pox });
  const [nonce, eligibility] = await Promise.all([
    fetchNonce({ address: sender, ...ctx.net }),
    fetchEligibleStake({
      staker: sender,
      signerManager: opts.signerManager,
      amountUstx: opts.amountUstx,
      numCycles: opts.cycles,
      startBurnHt,
      poxInfo: pox,
      ...ctx.net,
    }),
  ]);
  const blockers = eligibilityBlockers(eligibility);

  const baseRows: Row[] = [
    ['sender', explorerLink(ctx.config, sender)],
    ['signer-manager', explorerLink(ctx.config, opts.signerManager)],
    ['amount', stx(opts.amountUstx)],
    ['cycles', opts.cycles],
    ['first reward cycle', `${firstRewardCycle} (begins at Bitcoin block ${firstCycleStartHeight})`],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  if (!opts.broadcast) {
    output(
      ctx,
      { mode: 'dry-run', sender, signerManager: opts.signerManager, amountUstx: opts.amountUstx, cycles: opts.cycles, startBurnHt, firstRewardCycle, firstRewardCycleStartHeight: firstCycleStartHeight, fee: opts.fee, nonce, blockers },
      () => {
        printSection('Stake (dry run)');
        printRows(baseRows);
        for (const blocker of blockers) printNote(blocker);
        printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
      },
    );
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`stake would be rejected: ${blockers.join('; ')}`);
  }

  const tx = await buildStake({
    signerManager: opts.signerManager,
    amountUstx: opts.amountUstx,
    numCycles: opts.cycles,
    startBurnHt,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });
  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(
    ctx,
    { sender, signerManager: opts.signerManager, amountUstx: opts.amountUstx, cycles: opts.cycles, startBurnHt, firstRewardCycle, firstRewardCycleStartHeight: firstCycleStartHeight, fee: opts.fee, nonce, txid, status: outcome.status, result: outcome.resultRepr ?? null },
    () => {
      printSection('Stake');
      printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
      if (outcome.aborted) printNote('the transaction reverted on-chain — no STX was locked');
      else if (outcome.pending) printNote('still pending — re-check the explorer link or pox5 position');
    },
  );
  if (outcome.aborted) process.exitCode = 1;
}
