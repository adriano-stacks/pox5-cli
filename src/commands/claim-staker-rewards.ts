import { fetchEarnedStakerRewards } from '@stacks/bitcoin-staking';
import {
  PostConditionMode,
  fetchNonce,
  getAddressFromPrivateKey,
  makeUnsignedContractCall,
  noneCV,
  principalCV,
  privateKeyToPublic,
  publicKeyToHex,
  someCV,
  uintCV,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxAddress, resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchSbtcBalance } from '../pox.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

export interface ClaimStakerRewardsOpts {
  staker?: string;
  signerManager?: string;
  cycle: number;
  bond?: number;
  fee: bigint;
  broadcast: boolean;
}

async function managerHasClaimStakerRewards(ctx: Ctx, address: string, name: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${ctx.config.stacksApiUrl}/v2/contracts/interface/${address}/${name}`);
    if (!res.ok) return res.status === 404 ? false : undefined;
    const body = (await res.json()) as { functions?: { name: string }[] };
    return (body.functions ?? []).some((f) => f.name === 'claim-staker-rewards');
  } catch {
    return undefined;
  }
}

export async function claimStakerRewardsCommand(ctx: Ctx, opts: ClaimStakerRewardsOpts): Promise<void> {
  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
  const staker = opts.staker ?? resolveStxAddress(ctx);
  const signerManager = opts.signerManager ?? `${sender}.signer-manager`;
  const [smAddress, smName] = signerManager.split('.');
  if (!smAddress || !smName) {
    throw new CliError(`--signer-manager must be a contract principal <address>.<name> (got "${signerManager}")`);
  }

  const [earned, hasClaim, managerSbtc, nonce] = await Promise.all([
    fetchEarnedStakerRewards({ signerManager, rewardCycle: opts.cycle, bondIndex: opts.bond, staker, ...ctx.net }),
    managerHasClaimStakerRewards(ctx, smAddress, smName),
    fetchSbtcBalance(ctx, signerManager),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);
  const managerBalance = managerSbtc?.balance;

  const bondCv = opts.bond === undefined ? noneCV() : someCV(uintCV(opts.bond));
  const tx = await makeUnsignedContractCall({
    contractAddress: smAddress,
    contractName: smName,
    functionName: 'claim-staker-rewards',
    functionArgs: [principalCV(staker), uintCV(opts.cycle), bondCv],
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
    postConditionMode: PostConditionMode.Allow,
  });

  const leg = opts.bond === undefined ? `STX-only cycle ${opts.cycle}` : `bond ${opts.bond} @ cycle ${opts.cycle}`;
  const baseRows: Row[] = [
    ['caller', explorerLink(ctx.config, sender)],
    ['signer-manager', explorerLink(ctx.config, signerManager)],
    ['staker (paid)', explorerLink(ctx.config, staker)],
    ['leg', leg],
    ['earned (claimable)', sats(earned)],
    ['signer-manager sBTC balance', managerBalance !== undefined ? sats(managerBalance) : null],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const blockers: string[] = [];
  if (hasClaim === false) {
    blockers.push(
      `signer-manager ${signerManager} has no claim-staker-rewards entrypoint — deploy one with the passthrough (setup-signer)`,
    );
  }
  if (earned === 0n) {
    blockers.push(
      'no claimable staker rewards for this leg — the signer must be settled first (run claim-rewards for this cycle), ' +
        'and pass the --cycle / --bond the staker is delegating under',
    );
  } else if (managerBalance !== undefined && managerBalance < earned) {
    blockers.push(
      `signer-manager holds ${managerBalance} sats sBTC, below the ${earned} sats owed — run claim-rewards first to pull the slice into the manager`,
    );
  }

  const json = {
    caller: sender,
    signerManager,
    staker,
    rewardCycle: opts.cycle,
    bondIndex: opts.bond ?? null,
    earned,
    signerManagerSbtc: managerBalance ?? null,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection('Claim staker rewards (dry run)');
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      printNote('the signer-manager pays the staker from its own sBTC balance (filled by claim-rewards); your wallet sends nothing');
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`claim-staker-rewards would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection('Claim staker rewards');
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) printNote('the transaction reverted on-chain — no sBTC was paid out');
    else if (outcome.pending) printNote('still pending — re-check the explorer link');
    else printNote(`the signer-manager paid ${sats(earned)} to ${staker}`);
  });

  if (outcome.aborted) process.exitCode = 1;
}
