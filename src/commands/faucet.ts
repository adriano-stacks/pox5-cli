import {
  ClarityVersion,
  TransactionSigner,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  listCV,
  makeUnsignedContractCall,
  makeUnsignedContractDeploy,
  principalCV,
  privateKeyToPublic,
  publicKeyToHex,
  tupleCV,
  uintCV,
  type StacksTransactionWire,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { resolveBtcAddress, resolveSbtcDeployerPrivateKey, resolveStxAddress } from '../address.js';
import { bitcoinAddressLink, bitcoinTxLink, explorerLink, explorerTxLink } from '../explorer.js';
import { CliError } from '../errors.js';
import { output, printNote, printRows, printSection, sbtc, stx, type Row } from '../output.js';

async function postFaucet(url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new CliError(`faucet request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new CliError(`faucet returned ${res.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export interface FaucetStxOpts {
  stacking?: boolean;
}

export async function faucetStxCommand(ctx: Ctx, addressArg?: string, opts: FaucetStxOpts = {}): Promise<void> {
  const address = resolveStxAddress(ctx, addressArg);
  const params = new URLSearchParams({ address });
  if (opts.stacking) params.set('stacking', 'true');

  const body = await postFaucet(`${ctx.config.extendedApiUrl}/v1/faucets/stx?${params.toString()}`);
  const txid = (body.txId ?? body.txid) as string | undefined;
  output(ctx, { stacking: opts.stacking === true, ...body }, () => {
    printSection(`STX faucet — ${explorerLink(ctx.config, address)}`);
    printRows([
      ['mode', opts.stacking ? 'stacking (min_amount_ustx + 20%)' : 'standard (500 STX)'],
      ['success', body.success ?? true],
      ['txid', txid ? explorerTxLink(ctx.config, txid) : null],
    ]);
  });
}

export interface FaucetBtcOpts {
  large?: boolean;
  xlarge?: boolean;
}

export async function faucetBtcCommand(ctx: Ctx, addressArg: string | undefined, opts: FaucetBtcOpts): Promise<void> {
  const address = resolveBtcAddress(ctx, addressArg);
  const params = new URLSearchParams({ address });
  if (opts.xlarge) params.set('xlarge', 'true');
  else if (opts.large) params.set('large', 'true');
  const tier = opts.xlarge ? '0.5 BTC' : opts.large ? '0.01 BTC' : '0.0001 BTC';

  const body = await postFaucet(`${ctx.config.extendedApiUrl}/v1/faucets/btc?${params.toString()}`);
  const txid = (body.txid ?? body.txId) as string | undefined;
  output(ctx, { tier, ...body }, () => {
    printSection(`BTC faucet — ${bitcoinAddressLink(ctx.config, address)}`);
    printRows([
      ['tier', tier],
      ['success', body.success ?? true],
      ['txid', txid ? bitcoinTxLink(ctx.config, txid) : null],
    ]);
  });
}

const SBTC_TOKEN_CONTRACT = 'sbtc-token';
const SBTC_MINTER_CONTRACT = 'sbtc-deposit';
const DEFAULT_SBTC_SATS = 100_000_000n;

function minterSource(): string {
  return `(define-constant deployer tx-sender)
(define-constant ERR_UNAUTHORIZED (err u1000))

(define-public (mint-many (recipients (list 200 {amount: uint, recipient: principal})))
    (begin
        (asserts! (is-eq tx-sender deployer) ERR_UNAUTHORIZED)
        (contract-call? .${SBTC_TOKEN_CONTRACT} protocol-mint-many recipients 0x01)
    )
)
`;
}

async function contractExists(ctx: Ctx, address: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${ctx.config.stacksApiUrl}/v2/contracts/interface/${address}/${name}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function sendTx(ctx: Ctx, tx: StacksTransactionWire, privateKey: string): Promise<string> {
  const signer = new TransactionSigner(tx);
  signer.signOrigin(privateKey);
  const result = (await broadcastTransaction({ transaction: signer.getTxInComplete(), ...ctx.net })) as {
    txid?: string;
    error?: string;
    reason?: string;
  };
  if (result.error) throw new CliError(`broadcast rejected: ${result.reason ?? result.error}`);
  return result.txid!;
}

export interface FaucetSbtcOpts {
  sats?: bigint;
  sbtc?: number;
  deployFee: bigint;
  fee: bigint;
  broadcast: boolean;
}

export async function faucetSbtcCommand(ctx: Ctx, addressArg: string | undefined, opts: FaucetSbtcOpts): Promise<void> {
  let amountSats: bigint;
  if (opts.sats !== undefined) amountSats = opts.sats;
  else if (opts.sbtc !== undefined) amountSats = BigInt(Math.round(opts.sbtc * 1e8));
  else amountSats = DEFAULT_SBTC_SATS;
  if (amountSats <= 0n) throw new CliError('mint amount must be positive');

  const recipient = resolveStxAddress(ctx, addressArg);
  const privateKey = resolveSbtcDeployerPrivateKey();
  const deployer = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey.length === 64 ? privateKey + '01' : privateKey));

  const minter = `${deployer}.${SBTC_MINTER_CONTRACT}`;
  const deployed = await contractExists(ctx, deployer, SBTC_MINTER_CONTRACT);
  const nonce = await fetchNonce({ address: deployer, ...ctx.net });
  const deployNonce = nonce;
  const mintNonce = deployed ? nonce : nonce + 1n;

  const source = minterSource();
  const deployTx = deployed
    ? undefined
    : await makeUnsignedContractDeploy({
        contractName: SBTC_MINTER_CONTRACT,
        codeBody: source,
        clarityVersion: ClarityVersion.Clarity4,
        publicKey,
        fee: opts.deployFee,
        nonce: deployNonce,
        network: ctx.net.network,
      });

  const mintTx = await makeUnsignedContractCall({
    contractAddress: deployer,
    contractName: SBTC_MINTER_CONTRACT,
    functionName: 'mint-many',
    functionArgs: [listCV([tupleCV({ amount: uintCV(amountSats), recipient: principalCV(recipient) })])],
    publicKey,
    fee: opts.fee,
    nonce: mintNonce,
    network: ctx.net.network,
  });

  const baseRows: Row[] = [
    ['deployer', explorerLink(ctx.config, deployer)],
    ['sBTC token', explorerLink(ctx.config, `${deployer}.${SBTC_TOKEN_CONTRACT}`)],
    ['minter', explorerLink(ctx.config, minter)],
    ['deploy minter', deployed ? 'already deployed' : `needed (${source.length} bytes, Clarity 4)`],
    ['recipient', explorerLink(ctx.config, recipient)],
    ['amount', sbtc(amountSats)],
    ['fee', deployed ? stx(opts.fee) : `${stx(opts.deployFee)} (deploy) + ${stx(opts.fee)} (mint)`],
    ['nonce', deployed ? nonce : `${deployNonce} (deploy), ${mintNonce} (mint)`],
  ];

  const json = {
    deployer,
    minter,
    sbtcToken: `${deployer}.${SBTC_TOKEN_CONTRACT}`,
    recipient,
    amountSats,
    deployNeeded: !deployed,
    deployFee: deployed ? null : opts.deployFee,
    fee: opts.fee,
    nonce,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection('sBTC faucet (dry run)');
      printRows(baseRows);
      printNote('re-run with --broadcast to sign with the sBTC deployer key and send');
    });
    return;
  }

  const deployTxid = deployTx ? await sendTx(ctx, deployTx, privateKey) : undefined;
  let mintTxid: string | undefined;
  let mintError: string | undefined;
  try {
    mintTxid = await sendTx(ctx, mintTx, privateKey);
  } catch (e) {
    if (!deployTxid) throw e;
    mintError = (e as Error).message;
  }

  output(ctx, { ...json, deployTxid: deployTxid ?? null, mintTxid: mintTxid ?? null, mintError: mintError ?? null }, () => {
    printSection('sBTC faucet');
    printRows([
      ...baseRows,
      ['deploy txid', deployTxid ? explorerTxLink(ctx.config, deployTxid) : null],
      ['mint txid', mintTxid ? explorerTxLink(ctx.config, mintTxid) : null],
    ]);
    if (mintError) {
      printNote(`mint was not accepted (${mintError})`);
      printNote('re-run faucet sbtc --broadcast once the minter deploy confirms — it will skip the deploy and only mint');
    }
  });
}
