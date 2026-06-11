import {
  assembleLockupProofFromBlock,
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  buildDefaultUnlockScript,
  computeBondUnlockHeight,
  computeP2wshOutputScript,
  fetchBondAllowance,
  fetchBondMembership,
  fetchPoxInfo,
  fetchSignerInfo,
  isInPreparePhase,
  minUstxForSatsAmount,
  type BondL1LockupOutput,
} from '@stacks/bitcoin-staking';
import { bytesToHex, hexToBytes } from '@stacks/common';
import {
  TransactionSigner,
  broadcastTransaction,
  bufferCV,
  fetchNonce,
  getAddressFromPrivateKey,
  listCV,
  makeUnsignedContractCall,
  noneCV,
  principalCV,
  privateKeyToPublic,
  publicKeyToHex,
  responseOkCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import {
  btcNetwork,
  buildLockupScript,
  fetchBlockHashAtHeight,
  fetchBlockHeader,
  fetchBlockTxids,
  fetchBtcTxHex,
  fetchBtcTxStatus,
  resolveBtcKey,
  type BtcNetworkName,
} from '../btc.js';
import { bitcoinTxLink, explorerLink, explorerTxLink } from '../explorer.js';
import { fetchBondConfig, fetchLockupOutputScript, requirePoxWithBondCycle } from '../pox.js';
import {
  bitcoinBlocks,
  clearProgress,
  output,
  printNote,
  printRows,
  printSection,
  progress,
  sats,
  stx,
  type Row,
} from '../output.js';

const BLOCK_SCAN_LIMIT = 144;

export interface RegisterForBondOpts {
  bond: number;
  btcTxid: string;
  signerManager?: string;
  amountUstx?: bigint;
  btcNetwork: BtcNetworkName;
  fee: bigint;
  broadcast: boolean;
}

async function resolveLockBlock(
  ctx: Ctx,
  txid: string,
  currentBurnHeight: number,
): Promise<{ blockHash: string; height: number }> {
  const status = await fetchBtcTxStatus(ctx.config, txid);
  if (!status.confirmed || !status.block_hash) {
    throw new CliError(`Bitcoin transaction ${txid} is not confirmed yet — wait for it to land in a block`);
  }
  const blockHash = status.block_hash;
  for (let height = currentBurnHeight; height > Math.max(0, currentBurnHeight - BLOCK_SCAN_LIMIT); height--) {
    progress(`locating lock block… checking Bitcoin height ${height}`);
    const hash = await fetchBlockHashAtHeight(ctx.config, height);
    if (hash === blockHash) {
      clearProgress();
      return { blockHash, height };
    }
  }
  clearProgress();
  throw new CliError(
    `the block containing ${txid} (${blockHash}) is not within the last ${BLOCK_SCAN_LIMIT} ` +
      `Bitcoin blocks known to Stacks (current Stacks-side Bitcoin height: ${currentBurnHeight}) — `
      + 'the SPV check needs Stacks to have processed that block',
  );
}

export async function registerForBondCommand(ctx: Ctx, opts: RegisterForBondOpts): Promise<void> {
  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
  const signerManager = opts.signerManager ?? `${sender}.signer-manager`;

  const key = resolveBtcKey(btcNetwork(opts.btcNetwork));

  const [bond, poxRaw] = await Promise.all([fetchBondConfig(ctx, opts.bond), fetchPoxInfo(ctx.net)]);
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bond, poxInfo: pox });
  const firstRewardCycle = bondPeriodToRewardCycle({ bondIndex: opts.bond, poxInfo: pox });
  const tooLate = bitcoinHeight >= startBurnHeight;
  const inPrepare = isInPreparePhase({ burnHeight: bitcoinHeight, poxInfo: pox });

  const [signerInfo, membership, allowance, nonce] = await Promise.all([
    fetchSignerInfo({ signerManager, ...ctx.net }),
    fetchBondMembership({ address: sender, ...ctx.net }),
    fetchBondAllowance({ bondIndex: opts.bond, address: sender, ...ctx.net }),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);

  const lockBlock = await resolveLockBlock(ctx, opts.btcTxid, bitcoinHeight);
  const [txHex, header, txids] = await Promise.all([
    fetchBtcTxHex(ctx.config, opts.btcTxid),
    fetchBlockHeader(ctx.config, lockBlock.blockHash),
    fetchBlockTxids(ctx.config, lockBlock.blockHash),
  ]);

  const unlockHeight = computeBondUnlockHeight({ bondIndex: opts.bond, poxInfo: pox });
  const unlockBytes = buildDefaultUnlockScript(key.publicKey);
  const expectedScript = computeP2wshOutputScript(
    buildLockupScript({
      stxAddress: sender,
      unlockHeight,
      stakerUnlockBytes: unlockBytes,
      earlyUnlockBytes: bond.earlyUnlockBytes,
    }),
  );
  const onChainOutputScript = await fetchLockupOutputScript(ctx, {
    staker: sender,
    unlockHeight,
    stakerUnlockBytes: unlockBytes,
    earlyUnlockBytes: bond.earlyUnlockBytes,
  });
  if (onChainOutputScript !== bytesToHex(expectedScript)) {
    throw new CliError(
      'locally derived lockup script does not match the contract\'s construct-lockup-output-script — ' +
        'registration would be rejected (ERR_INVALID_LOCKUP_SCRIPT u42; the script template likely changed; update the CLI)',
    );
  }

  let lockup: BondL1LockupOutput;
  try {
    lockup = assembleLockupProofFromBlock({
      txHex,
      header,
      blockHeight: lockBlock.height,
      txids,
      expectedScript,
    });
  } catch (e) {
    throw new CliError(
      `could not assemble the lockup proof: ${(e as Error).message} — ` +
        'check that the transaction pays the lock address derived from this staker, bond, and POX5_BTC_WIF (see lock-btc)',
    );
  }

  const lockedSats = lockup.amount;
  const minUstx = minUstxForSatsAmount({
    sats: lockedSats,
    stxValueRatio: bond.stxValueRatio,
    minUstxRatioBps: bond.minUstxRatioBps,
  });
  const amountUstx = opts.amountUstx ?? minUstx;
  if (amountUstx < minUstx) {
    throw new CliError(
      `--amount ${amountUstx} uSTX is below the bond minimum ${minUstx} uSTX for ${lockedSats} sats (ERR_INSUFFICIENT_STX u8)`,
    );
  }

  const toBytes = (v: Uint8Array | string): Uint8Array => (typeof v === 'string' ? hexToBytes(v) : v);
  const tx = await makeUnsignedContractCall({
    contractAddress: ctx.net.network.bootAddress,
    contractName: 'pox-5',
    functionName: 'register-for-bond',
    functionArgs: [
      uintCV(opts.bond),
      principalCV(signerManager),
      uintCV(amountUstx),
      responseOkCV(
        tupleCV({
          outputs: listCV([
            tupleCV({
              height: uintCV(lockup.height),
              tx: bufferCV(toBytes(lockup.tx)),
              'output-index': uintCV(lockup.outputIndex),
              header: bufferCV(toBytes(lockup.header)),
              'leaf-hashes': listCV(lockup.leafHashes.map((h) => bufferCV(toBytes(h)))),
              'tx-count': uintCV(lockup.txCount),
              'tx-index': uintCV(lockup.txIndex),
              amount: uintCV(lockup.amount),
            }),
          ]),
          'staker-unlock-bytes': bufferCV(unlockBytes),
        }),
      ),
      noneCV(),
    ],
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });

  const baseRows: Row[] = [
    ['staker', explorerLink(ctx.config, sender)],
    ['signer-manager', explorerLink(ctx.config, signerManager)],
    ['bond', opts.bond],
    ['first reward cycle', firstRewardCycle],
    ['bond start', `Bitcoin block ${startBurnHeight} (in ${bitcoinBlocks(Math.max(0, startBurnHeight - bitcoinHeight))})`],
    ['BTC commitment', sats(lockedSats)],
    ['lock tx', bitcoinTxLink(ctx.config, opts.btcTxid)],
    ['lock block', `Bitcoin block ${lockBlock.height} (${txids.length} txs, proof depth ${lockup.leafHashes.length})`],
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
    blockers.push('the chain is in the prepare phase — registration is rejected until the next reward phase (ERR_STAKE_IN_PREPARE_PHASE u47)');
  }
  if (signerInfo === undefined) {
    blockers.push(`signer-manager ${signerManager} is not registered (ERR_SIGNER_NOT_FOUND u23) — run setup-signer`);
  }
  if (allowance < lockedSats) {
    blockers.push(`allowlist cap is ${allowance} sats, below the ${lockedSats} sats lock (ERR_TOO_MUCH_SATS u10)`);
  }
  if (membership !== undefined && Math.abs(membership.bondIndex - opts.bond) < 6) {
    blockers.push(`staker already holds an overlapping bond membership (bond ${membership.bondIndex}) (ERR_ALREADY_REGISTERED u9)`);
  }

  const json = {
    staker: sender,
    signerManager,
    bondIndex: opts.bond,
    firstRewardCycle,
    bondStartHeight: startBurnHeight,
    btcTxid: opts.btcTxid,
    lockBlockHeight: lockBlock.height,
    lockedSats,
    amountUstx,
    minUstx,
    allowanceSats: allowance,
    unlockHeight,
    unlockBytes: bytesToHex(unlockBytes),
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Register for bond ${opts.bond} (dry run)`);
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`registration would be rejected: ${blockers.join('; ')}`);
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
    printSection(`Register for bond ${opts.bond}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)]]);
    printNote('keep POX5_BTC_WIF safe — its key is the only way to spend the lock after the unlock height');
  });
}
