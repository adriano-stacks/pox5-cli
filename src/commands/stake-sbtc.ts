import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  buildRegisterForBond,
  fetchBondAllowance,
  fetchEligibleRegisterForBond,
  fetchPoxInfo,
  fetchProtocolBond,
  minUstxForSatsAmount,
} from '@stacks/bitcoin-staking';
import {
  Pc,
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError, eligibilityBlockers } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchSbtcBalance, fetchSbtcContractId, requirePoxWithBondCycle } from '../pox.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import {
  bitcoinBlocks,
  output,
  printNote,
  printRows,
  printSection,
  sats,
  sbtc,
  stx,
  type Row,
} from '../output.js';

export interface StakeSbtcOpts {
  bond: number;
  amountSats: bigint;
  signerManager?: string;
  amountUstx?: bigint;
  fee: bigint;
  broadcast: boolean;
}

export async function stakeSbtcCommand(ctx: Ctx, opts: StakeSbtcOpts): Promise<void> {
  if (opts.amountSats <= 0n) throw new CliError('sBTC stake amount must be positive');

  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
  const signerManager = opts.signerManager ?? `${sender}.signer-manager`;

  const [bond, poxRaw] = await Promise.all([
    fetchProtocolBond({ bondIndex: opts.bond, ...ctx.net }),
    fetchPoxInfo(ctx.net),
  ]);
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bond, poxInfo: pox });
  const firstRewardCycle = bondPeriodToRewardCycle({ bondIndex: opts.bond, poxInfo: pox });

  const minUstx = minUstxForSatsAmount({
    sats: opts.amountSats,
    stxValueRatio: bond.stxValueRatio,
    minUstxRatioBps: bond.minUstxRatioBps,
  });
  const amountUstx = opts.amountUstx ?? minUstx;

  const [allowance, nonce, sbtcInfo, eligibility] = await Promise.all([
    fetchBondAllowance({ bondIndex: opts.bond, address: sender, ...ctx.net }),
    fetchNonce({ address: sender, ...ctx.net }),
    fetchSbtcBalance(ctx, sender),
    fetchEligibleRegisterForBond({
      bondIndex: opts.bond,
      staker: sender,
      amountUstx,
      signerManager,
      lockup: { kind: 'sbtc', sbtcSats: opts.amountSats },
      poxInfo: pox,
      ...ctx.net,
    }),
  ]);

  const sbtcContractId = sbtcInfo?.contractId ?? (await fetchSbtcContractId(ctx));
  if (!sbtcContractId) {
    throw new CliError(
      'could not resolve the sBTC token contract from pox-5 source — cannot build the sBTC transfer post-condition',
    );
  }
  const sbtcBalance = sbtcInfo?.balance;

  const postConditions = [
    Pc.principal(sender)
      .willSendLte(opts.amountSats)
      .ft(sbtcContractId as `${string}.${string}`, 'sbtc-token'),
  ];
  const tx = await buildRegisterForBond({
    bondIndex: opts.bond,
    signerManager,
    amountUstx,
    lockup: { kind: 'sbtc', sbtcSats: opts.amountSats },
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
    postConditions,
    postConditionMode: 'deny',
  });

  const baseRows: Row[] = [
    ['staker', explorerLink(ctx.config, sender)],
    ['signer-manager', explorerLink(ctx.config, signerManager)],
    ['bond', opts.bond],
    ['first reward cycle', firstRewardCycle],
    ['bond start', `Bitcoin block ${startBurnHeight} (in ${bitcoinBlocks(Math.max(0, startBurnHeight - bitcoinHeight))})`],
    ['sBTC stake', sbtc(opts.amountSats)],
    ['sBTC token', explorerLink(ctx.config, sbtcContractId)],
    ['sBTC balance', sbtcBalance !== undefined ? sbtc(sbtcBalance) : null],
    ['paired STX', `${stx(amountUstx)} (minimum ${stx(minUstx)})`],
    ['allowlist cap', allowance === undefined ? 'not allowlisted' : sats(allowance)],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const blockers = eligibilityBlockers(eligibility);
  if (sbtcBalance !== undefined && sbtcBalance < opts.amountSats) {
    blockers.push(`sBTC balance is ${sbtcBalance} sats, below the ${opts.amountSats} sats stake — the contract's sBTC transfer would fail (run faucet sbtc)`);
  }

  const json = {
    staker: sender,
    signerManager,
    bondIndex: opts.bond,
    firstRewardCycle,
    bondStartHeight: startBurnHeight,
    amountSats: opts.amountSats,
    sbtcToken: sbtcContractId,
    sbtcBalance: sbtcBalance ?? null,
    amountUstx,
    minUstx,
    allowanceSats: allowance ?? null,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Stake sBTC into bond ${opts.bond} (dry run)`);
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`staking would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection(`Stake sBTC into bond ${opts.bond}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) printNote('the transaction reverted on-chain — no sBTC was staked');
    else if (outcome.pending) printNote('still pending — re-check the explorer link or pox5 position');
    else printNote('the contract now custodies your sBTC; withdraw with unstake-sbtc after the bond starts');
  });
  if (outcome.aborted) process.exitCode = 1;
}
