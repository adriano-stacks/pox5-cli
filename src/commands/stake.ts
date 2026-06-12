import {
  burnHeightToRewardCycle,
  buildStake,
  fetchPoxInfo,
  isInPreparePhase,
  rewardCycleToBurnHeight,
} from '@stacks/bitcoin-staking';
import {
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { output, printNote, printRows, printSection, stx, type Row } from '../output.js';

const MAX_CYCLES = 96;

export interface StakeOpts {
  signerManager: string;
  amountUstx: bigint;
  cycles: number;
  startHeight?: number;
  fee: bigint;
  broadcast: boolean;
}

export async function stakeCommand(ctx: Ctx, opts: StakeOpts): Promise<void> {
  if (opts.cycles < 1 || opts.cycles > MAX_CYCLES) {
    throw new CliError(`--cycles must be between 1 and ${MAX_CYCLES} (got ${opts.cycles})`);
  }

  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const pox = await fetchPoxInfo(ctx.net);
  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  if (isInPreparePhase({ burnHeight: bitcoinHeight, poxInfo: pox })) {
    throw new CliError(
      'cannot stake during the prepare phase (ERR_STAKE_IN_PREPARE_PHASE u47) — wait for the next reward phase',
    );
  }

  const startBurnHt = opts.startHeight ?? bitcoinHeight;
  if (burnHeightToRewardCycle({ burnHeight: startBurnHt, poxInfo: pox }) !== pox.rewardCycleId) {
    throw new CliError(
      `--start-height ${startBurnHt} is not in the current reward cycle (${pox.rewardCycleId}); ` +
        'stake requires the start height to fall in the current cycle',
    );
  }
  const firstRewardCycle = pox.rewardCycleId + 1;
  const firstCycleStartHeight = rewardCycleToBurnHeight({ cycle: firstRewardCycle, poxInfo: pox });
  const nonce = await fetchNonce({ address: sender, ...ctx.net });

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
      { mode: 'dry-run', sender, signerManager: opts.signerManager, amountUstx: opts.amountUstx, cycles: opts.cycles, startBurnHt, firstRewardCycle, firstRewardCycleStartHeight: firstCycleStartHeight, fee: opts.fee, nonce },
      () => {
        printSection('Stake (dry run)');
        printRows(baseRows);
        printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
      },
    );
    return;
  }

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
