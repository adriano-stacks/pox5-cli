import {
  PostConditionMode,
  fetchNonce,
  getAddressFromPrivateKey,
  listCV,
  makeUnsignedContractCall,
  privateKeyToPublic,
  publicKeyToHex,
  uintCV,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { fetchEarnedRewards } from '../pox.js';
import { signAndConfirm, txStatusLabel } from '../tx.js';
import { output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const MAX_BOND_PERIODS = 6;

export interface ClaimRewardsOpts {
  signerManager?: string;
  cycle: number;
  bonds: number[];
  fee: bigint;
  broadcast: boolean;
}

async function managerHasClaimRewards(ctx: Ctx, address: string, name: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${ctx.config.stacksApiUrl}/v2/contracts/interface/${address}/${name}`);
    if (!res.ok) return res.status === 404 ? false : undefined;
    const body = (await res.json()) as { functions?: { name: string }[] };
    return (body.functions ?? []).some((f) => f.name === 'claim-rewards');
  } catch {
    return undefined;
  }
}

export async function claimRewardsCommand(ctx: Ctx, opts: ClaimRewardsOpts): Promise<void> {
  if (opts.bonds.length > MAX_BOND_PERIODS) {
    throw new CliError(`at most ${MAX_BOND_PERIODS} bonds can be passed (got ${opts.bonds.length})`);
  }

  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
  const signerManager = opts.signerManager ?? `${sender}.signer-manager`;
  const [smAddress, smName] = signerManager.split('.');
  if (!smAddress || !smName) {
    throw new CliError(`--signer-manager must be a contract principal <address>.<name> (got "${signerManager}")`);
  }

  const [stxEarned, bondEarned, hasClaim, nonce] = await Promise.all([
    fetchEarnedRewards(ctx, { signer: signerManager, rewardCycle: opts.cycle }),
    Promise.all(opts.bonds.map((bondIndex) => fetchEarnedRewards(ctx, { signer: signerManager, rewardCycle: opts.cycle, bondIndex }))),
    managerHasClaimRewards(ctx, smAddress, smName),
    fetchNonce({ address: sender, ...ctx.net }),
  ]);
  const bondTotal = bondEarned.reduce((acc, v) => acc + v, 0n);
  const totalEarned = stxEarned + bondTotal;

  const tx = await makeUnsignedContractCall({
    contractAddress: smAddress,
    contractName: smName,
    functionName: 'claim-rewards',
    functionArgs: [listCV(opts.bonds.map((i) => uintCV(i))), uintCV(opts.cycle)],
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
    postConditionMode: PostConditionMode.Allow,
  });

  const baseRows: Row[] = [
    ['caller', explorerLink(ctx.config, sender)],
    ['signer-manager (signer)', explorerLink(ctx.config, signerManager)],
    ['reward cycle', opts.cycle],
    ['STX-only leg earned', sats(stxEarned)],
  ];
  opts.bonds.forEach((bondIndex, idx) => baseRows.push([`bond ${bondIndex} earned`, sats(bondEarned[idx]!)]));
  baseRows.push(['total claimable', sats(totalEarned)], ['fee', stx(opts.fee)], ['nonce', nonce]);

  const blockers: string[] = [];
  if (hasClaim === false) {
    blockers.push(
      `signer-manager ${signerManager} has no claim-rewards entrypoint — the minimal setup-signer manager cannot ` +
        'forward claims; deploy one whose claim-rewards calls (contract-call? .pox-5 claim-rewards bond-periods reward-cycle)',
    );
  }
  if (totalEarned === 0n) {
    blockers.push(
      'no claimable sBTC across the requested legs (ERR_NO_CLAIMABLE_REWARDS u32) — run calculate-rewards first, ' +
        'and pass the settled --cycle plus each --bond leg the signer covers',
    );
  }

  const json = {
    caller: sender,
    signerManager,
    rewardCycle: opts.cycle,
    bonds: opts.bonds,
    stxEarned,
    bondEarned,
    totalEarned,
    fee: opts.fee,
    nonce,
    blockers,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection('Claim rewards (dry run)');
      printRows(baseRows);
      for (const blocker of blockers) printNote(blocker);
      printNote('the registered signer is the signer-manager contract, so the claim routes through it (contract-caller == signer)');
      printNote('the contract — not your wallet — sends the sBTC, so post-conditions run in allow mode');
      printNote('fan the claimed sBTC out to individual stakers from the signer-manager (claim-staker-rewards-for-signer)');
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (blockers.length > 0) {
    throw new CliError(`claim-rewards would be rejected: ${blockers.join('; ')}`);
  }

  const { txid, outcome } = await signAndConfirm(ctx, tx, privateKey);

  output(ctx, { ...json, txid, status: outcome.status, result: outcome.resultRepr ?? null }, () => {
    printSection('Claim rewards');
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)], ['result', txStatusLabel(outcome)]]);
    if (outcome.aborted) {
      printNote('the transaction reverted on-chain — no sBTC was transferred');
    } else if (outcome.pending) {
      printNote('still pending — re-check the explorer link, then verify with pox5 rewards');
    } else {
      printNote('the sBTC now sits in the signer-manager; distribute to stakers with claim-staker-rewards-for-signer');
    }
  });

  if (outcome.aborted) process.exitCode = 1;
}
