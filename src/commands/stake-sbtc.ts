import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  fetchBondAllowance,
  fetchBondMembership,
  fetchPoxInfo,
  fetchSignerInfo,
  isInPreparePhase,
  minUstxForSatsAmount,
} from '@stacks/bitcoin-staking';
import {
  Pc,
  PostConditionMode,
  TransactionSigner,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  makeUnsignedContractCall,
  noneCV,
  principalCV,
  privateKeyToPublic,
  publicKeyToHex,
  responseErrorCV,
  uintCV,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchBondConfig, fetchSbtcBalance, fetchSbtcContractId, requirePoxWithBondCycle } from '../pox.js';
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

  const [bond, poxRaw] = await Promise.all([fetchBondConfig(ctx, opts.bond), fetchPoxInfo(ctx.net)]);
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bond, poxInfo: pox });
  const firstRewardCycle = bondPeriodToRewardCycle({ bondIndex: opts.bond, poxInfo: pox });
  const tooLate = bitcoinHeight >= startBurnHeight;
  const inPrepare = isInPreparePhase({ burnHeight: bitcoinHeight, poxInfo: pox });

  const [signerInfo, membership, allowance, nonce, sbtcInfo] = await Promise.all([
    fetchSignerInfo({ signerManager, ...ctx.net }),
    fetchBondMembership({ address: sender, ...ctx.net }),
    fetchBondAllowance({ bondIndex: opts.bond, address: sender, ...ctx.net }),
    fetchNonce({ address: sender, ...ctx.net }),
    fetchSbtcBalance(ctx, sender),
  ]);

  const sbtcContractId = sbtcInfo?.contractId ?? (await fetchSbtcContractId(ctx));
  if (!sbtcContractId) {
    throw new CliError(
      'could not resolve the sBTC token contract from pox-5 source — cannot build the sBTC transfer post-condition',
    );
  }
  const sbtcBalance = sbtcInfo?.balance;

  const minUstx = minUstxForSatsAmount({
    sats: opts.amountSats,
    stxValueRatio: bond.stxValueRatio,
    minUstxRatioBps: bond.minUstxRatioBps,
  });
  const amountUstx = opts.amountUstx ?? minUstx;
  if (amountUstx < minUstx) {
    throw new CliError(
      `--amount ${amountUstx} uSTX is below the bond minimum ${minUstx} uSTX for ${opts.amountSats} sats (ERR_INSUFFICIENT_STX u8)`,
    );
  }

  const postConditions = [
    Pc.principal(sender)
      .willSendLte(opts.amountSats)
      .ft(sbtcContractId as `${string}.${string}`, 'sbtc-token'),
  ];
  const tx = await makeUnsignedContractCall({
    contractAddress: ctx.net.network.bootAddress,
    contractName: 'pox-5',
    functionName: 'register-for-bond',
    functionArgs: [
      uintCV(opts.bond),
      principalCV(signerManager),
      uintCV(amountUstx),
      responseErrorCV(uintCV(opts.amountSats)),
      noneCV(),
    ],
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
    postConditions,
    postConditionMode: PostConditionMode.Deny,
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
    ['allowlist cap', sats(allowance)],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const blockers: string[] = [];
  if (tooLate) {
    blockers.push(`bond ${opts.bond} already started at Bitcoin block ${startBurnHeight} (ERR_BOND_ALREADY_STARTED u43)`);
  }
  if (inPrepare) {
    blockers.push('the chain is in the prepare phase — staking is rejected until the next reward phase (ERR_STAKE_IN_PREPARE_PHASE u47)');
  }
  if (signerInfo === undefined) {
    blockers.push(`signer-manager ${signerManager} is not registered (ERR_SIGNER_NOT_FOUND u23) — run setup-signer`);
  }
  if (allowance < opts.amountSats) {
    blockers.push(`allowlist cap is ${allowance} sats, below the ${opts.amountSats} sats stake (ERR_TOO_MUCH_SATS u10)`);
  }
  if (membership !== undefined && Math.abs(membership.bondIndex - opts.bond) < 6) {
    blockers.push(`staker already holds an overlapping bond membership (bond ${membership.bondIndex}) (ERR_ALREADY_REGISTERED u9)`);
  }
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
    allowanceSats: allowance,
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

  const signer = new TransactionSigner(tx);
  signer.signOrigin(privateKey);
  const result = (await broadcastTransaction({ transaction: signer.getTxInComplete(), ...ctx.net })) as {
    txid?: string;
    error?: string;
    reason?: string;
  };
  if (result.error) throw new CliError(`broadcast rejected: ${result.reason ?? result.error}`);
  const txid = result.txid!;

  output(ctx, { ...json, txid }, () => {
    printSection(`Stake sBTC into bond ${opts.bond}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)]]);
    printNote('the contract now custodies your sBTC; withdraw with unstake-sbtc after the bond starts');
  });
}
