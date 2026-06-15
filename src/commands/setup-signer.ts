import {
  computeSignerGrantHash,
  fetchSignerGrantMessageHash,
  fetchSignerInfo,
  signSignerGrant,
  verifySignerGrant,
} from '@stacks/bitcoin-staking';
import { bytesToHex, hexToBytes } from '@stacks/common';
import {
  ClarityVersion,
  bufferCV,
  contractPrincipalCV,
  fetchNonce,
  getAddressFromPrivateKey,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  privateKeyToPublic,
  publicKeyToHex,
  uintCV,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveSignerPrivateKey, resolveStxPrivateKey } from '../address.js';
import { explorerLink } from '../explorer.js';
import { fetchSbtcContractId } from '../pox.js';
import { deployThenCall, twoStepAborted, twoStepNotes, twoStepRows, twoStepSucceeded } from '../tx.js';
import { output, printNote, printRows, printSection, stx, type Row } from '../output.js';

export interface SetupSignerOpts {
  name: string;
  authId: number;
  deployFee: bigint;
  fee: bigint;
  broadcast: boolean;
}

function signerManagerSource(bootAddress: string, sbtcContractId: string): string {
  const pox5 = `'${bootAddress}.pox-5`;
  const sbtc = `'${sbtcContractId}`;
  return `(impl-trait ${pox5}.signer-manager-trait)
(use-trait signer-manager-trait ${pox5}.signer-manager-trait)

(define-constant deployer tx-sender)
(define-constant ERR_UNAUTHORIZED (err u1000))

(define-public (validate-stake!
        (staker principal)
        (first-index uint)
        (num-indexes uint)
        (amount-ustx uint)
        (amount-sats uint)
        (is-bond bool)
        (signer-calldata (optional (buff 500)))
    )
    (ok (asserts! (is-eq contract-caller ${pox5}) ERR_UNAUTHORIZED))
)

(define-public (register-self
        (self <signer-manager-trait>)
        (signer-key (buff 33))
        (auth-id uint)
        (signer-sig (buff 65))
    )
    (begin
        (asserts! (is-eq tx-sender deployer) ERR_UNAUTHORIZED)
        (asserts! (is-eq (contract-of self) current-contract) ERR_UNAUTHORIZED)
        (try! (contract-call? ${pox5} grant-signer-key signer-key current-contract auth-id signer-sig))
        (contract-call? ${pox5} register-signer self signer-key)
    )
)

(define-public (claim-rewards
        (bond-periods (list 6 uint))
        (reward-cycle uint)
    )
    (contract-call? ${pox5} claim-rewards bond-periods reward-cycle)
)

(define-public (claim-staker-rewards
        (staker principal)
        (reward-cycle uint)
        (bond-index (optional uint))
    )
    (let (
            (info (try! (contract-call? ${pox5} claim-staker-rewards-for-signer staker reward-cycle bond-index)))
            (earned (get earned info))
        )
        (if (> earned u0)
            (try! (as-contract?
                ((with-ft ${sbtc} "sbtc-token" earned))
                (begin
                    (try! (contract-call? ${sbtc} transfer earned tx-sender staker none))
                    true
                )
            ))
            true
        )
        (ok info)
    )
)
`;
}

function compressedPublicKey(privateKey: string): string {
  const key = privateKey.length === 64 ? privateKey + '01' : privateKey;
  return publicKeyToHex(privateKeyToPublic(key));
}

async function contractExists(ctx: Ctx, address: string, name: string): Promise<boolean> {
  const url = `${ctx.config.stacksApiUrl}/v2/contracts/interface/${address}/${name}`;
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

export async function setupSignerCommand(ctx: Ctx, opts: SetupSignerOpts): Promise<void> {
  const privateKey = resolveStxPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = compressedPublicKey(privateKey);

  const signerPrivateKey = resolveSignerPrivateKey();
  const signerKey = compressedPublicKey(signerPrivateKey);

  const signerManager = `${sender}.${opts.name}`;
  const grantOpts = { signerManager, authId: opts.authId, chainId: ctx.net.network.chainId };

  const [deployed, info, onChainHash] = await Promise.all([
    contractExists(ctx, sender, opts.name),
    fetchSignerInfo({ signerManager, ...ctx.net }),
    fetchSignerGrantMessageHash({ signerManager, authId: opts.authId, ...ctx.net }),
  ]);

  if (info !== undefined) {
    output(ctx, { signerManager, registered: true, signerKey: info.signerKey }, () => {
      printSection(`Setup signer — ${explorerLink(ctx.config, signerManager)}`);
      printRows([
        ['registered', true],
        ['signer key', info.signerKey],
      ]);
      printNote('this signer-manager is already registered — nothing to do');
    });
    return;
  }

  const signature = signSignerGrant({ ...grantOpts, privateKey: signerPrivateKey });
  const localHash = bytesToHex(computeSignerGrantHash(grantOpts));
  const hashMatch = localHash === onChainHash.replace(/^0x/, '');
  const signatureValid = verifySignerGrant({ ...grantOpts, publicKey: signerKey, signature });
  if (!signatureValid) throw new CliError('signer-key grant signature failed local verification');

  const sbtcContractId = await fetchSbtcContractId(ctx);
  if (!sbtcContractId) {
    throw new CliError(
      'could not resolve the sBTC token contract from pox-5 source — needed for the manager’s claim-staker-rewards payout',
    );
  }
  const source = signerManagerSource(ctx.net.network.bootAddress, sbtcContractId);
  const nonce = await fetchNonce({ address: sender, ...ctx.net });
  const deployNonce = nonce;
  const registerNonce = deployed ? nonce : nonce + 1n;

  const deployTx = deployed
    ? undefined
    : await makeUnsignedContractDeploy({
        contractName: opts.name,
        codeBody: source,
        clarityVersion: ClarityVersion.Clarity4,
        publicKey,
        fee: opts.deployFee,
        nonce: deployNonce,
        network: ctx.net.network,
      });

  const registerTx = await makeUnsignedContractCall({
    contractAddress: sender,
    contractName: opts.name,
    functionName: 'register-self',
    functionArgs: [
      contractPrincipalCV(sender, opts.name),
      bufferCV(hexToBytes(signerKey)),
      uintCV(opts.authId),
      bufferCV(hexToBytes(signature)),
    ],
    publicKey,
    fee: opts.fee,
    nonce: registerNonce,
    network: ctx.net.network,
  });

  const baseRows: Row[] = [
    ['sender', explorerLink(ctx.config, sender)],
    ['signer-manager', explorerLink(ctx.config, signerManager)],
    ['deploy', deployed ? 'already deployed' : `needed (${source.length} bytes, Clarity 4)`],
    ['signer key', signerKey],
    ['auth id', opts.authId],
    ['grant hash', localHash],
    ['grant hash matches pox-5', hashMatch],
    ['grant signature valid', signatureValid],
    ['fee', deployed ? stx(opts.fee) : `${stx(opts.deployFee)} (deploy) + ${stx(opts.fee)} (register)`],
    ['nonce', deployed ? nonce : `${deployNonce} (deploy), ${registerNonce} (register)`],
  ];

  const json = {
    sender,
    signerManager,
    deployNeeded: !deployed,
    signerKey,
    authId: opts.authId,
    grantHash: localHash,
    grantHashMatches: hashMatch,
    deployFee: deployed ? null : opts.deployFee,
    fee: opts.fee,
    nonce,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Setup signer — ${opts.name} (dry run)`);
      printRows(baseRows);
      if (!hashMatch) {
        printNote('the locally computed grant hash does not match pox-5 — check --chain-id; a broadcast would fail signature recovery');
      }
      printNote('re-run with --broadcast to sign with POX5_STX_PRIVATE_KEY and send');
    });
    return;
  }

  if (!hashMatch) {
    throw new CliError(
      'locally computed grant hash does not match the pox-5 get-signer-grant-message-hash read-only — ' +
        'the grant signature would fail recovery (check the configured chain id)',
    );
  }

  // Deploy, wait for it to confirm, then register-self — see deployThenCall.
  const result = await deployThenCall(ctx, deployTx, registerTx, privateKey);
  const registered = twoStepSucceeded(result);

  output(
    ctx,
    {
      ...json,
      deployTxid: result.deployTxid ?? null,
      deployStatus: result.deployOutcome?.status ?? null,
      registerTxid: result.callTxid ?? null,
      registerStatus: result.callOutcome?.status ?? null,
      skipped: result.skipped ?? null,
      registered,
    },
    () => {
      printSection(`Setup signer — ${opts.name}`);
      printRows([...baseRows, ...twoStepRows(ctx, result, { deploy: 'deploy', call: 'register' })]);
      for (const note of twoStepNotes(result, { call: 'register-self' })) printNote(note);
      if (registered) printNote('signer-manager deployed and registered — ready to stake');
    },
  );
  if (twoStepAborted(result)) process.exitCode = 1;
}
