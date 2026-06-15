import * as btc from '@scure/btc-signer';
import { signECDSA } from '@scure/btc-signer/utils.js';
import { bytesToHex, hexToBytes } from '@stacks/common';
import { privateKeyToPublic, publicKeyToHex } from '@stacks/transactions';
import type { Config } from './config.js';
import { CliError } from './errors.js';

export type BtcNetworkName = 'regtest' | 'testnet' | 'signet' | 'mainnet';

export const BTC_NETWORK_NAMES: BtcNetworkName[] = ['regtest', 'testnet', 'signet', 'mainnet'];

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export function btcNetwork(name: BtcNetworkName): typeof btc.NETWORK {
  switch (name) {
    case 'mainnet':
      return btc.NETWORK;
    case 'testnet':
    case 'signet':
      return btc.TEST_NETWORK;
    case 'regtest':
      return REGTEST;
    default:
      throw new CliError(`unknown btc network "${name}" (expected ${BTC_NETWORK_NAMES.join(' | ')})`);
  }
}

export interface BtcKey {
  privateKey: Uint8Array;
  publicKey: string;
  address: string;
}

export function resolveBtcKey(network: typeof btc.NETWORK): BtcKey {
  const wif = process.env.POX5_BTC_WIF;
  if (!wif) throw new CliError('POX5_BTC_WIF is not set — needed to derive the Bitcoin lock and sign the funding transaction');
  let privateKey: Uint8Array;
  try {
    privateKey = btc.WIF(network).decode(wif);
  } catch (e) {
    throw new CliError(`POX5_BTC_WIF is not a valid WIF for this network: ${(e as Error).message}`);
  }
  const publicKey = publicKeyToHex(privateKeyToPublic(bytesToHex(privateKey) + '01'));
  const address = btc.getAddress('wpkh', privateKey, network);
  if (!address) throw new CliError('failed to derive a p2wpkh address from POX5_BTC_WIF');
  return { privateKey, publicKey, address };
}

async function esplora(config: Config, path: string): Promise<string> {
  const url = `${config.bitcoinApiUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new CliError(`Bitcoin API request failed (${url}): ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok || text.startsWith('<')) {
    throw new CliError(`Bitcoin API returned ${res.status} for ${path}: ${text.replace(/<[^>]*>/g, ' ').trim().slice(0, 200)}`);
  }
  return text;
}

export function fetchBtcTxHex(config: Config, txid: string): Promise<string> {
  return esplora(config, `/tx/${txid}/hex`);
}

export interface BtcTxStatus {
  confirmed: boolean;
  block_hash?: string;
}

export async function fetchBtcTxStatus(config: Config, txid: string): Promise<BtcTxStatus> {
  return JSON.parse(await esplora(config, `/tx/${txid}/status`)) as BtcTxStatus;
}

export function fetchBlockHeader(config: Config, blockHash: string): Promise<string> {
  return esplora(config, `/block/${blockHash}/header`);
}

export async function fetchBlockTxids(config: Config, blockHash: string): Promise<string[]> {
  return JSON.parse(await esplora(config, `/block/${blockHash}/txids`)) as string[];
}

export async function fetchBlockHashAtHeight(config: Config, height: number): Promise<string | undefined> {
  try {
    return await esplora(config, `/block-height/${height}`);
  } catch {
    return undefined;
  }
}

export async function fetchBtcBalanceSats(config: Config, address: string): Promise<bigint | undefined> {
  let body: string;
  try {
    body = await esplora(config, `/address/${address}`);
  } catch {
    return undefined;
  }
  try {
    const d = JSON.parse(body) as {
      chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
      mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
    };
    const net = (s?: { funded_txo_sum?: number; spent_txo_sum?: number }): bigint =>
      BigInt(s?.funded_txo_sum ?? 0) - BigInt(s?.spent_txo_sum ?? 0);
    return net(d.chain_stats) + net(d.mempool_stats);
  } catch {
    return undefined;
  }
}

export async function broadcastBtcTx(config: Config, txHex: string): Promise<string> {
  const url = `${config.bitcoinApiUrl}/tx`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: txHex });
  } catch (e) {
    throw new CliError(`Bitcoin broadcast failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new CliError(`Bitcoin broadcast rejected: ${text.slice(0, 300)}`);
  return text.trim();
}

export interface SingleKeyEarlyUnlock {
  publicKey: string;
  needsFiller: boolean;
}

export function parseSingleKeyEarlyUnlock(earlyUnlockBytesHex: string): SingleKeyEarlyUnlock | undefined {
  const m = /^21([0-9a-f]{66})(ac|ad)$/.exec(earlyUnlockBytesHex.toLowerCase());
  if (!m) return undefined;
  return { publicKey: m[1]!, needsFiller: m[2] === 'ad' };
}

export interface EarlyExitSpend {
  txid: string;
  txHex: string;
  outputSats: bigint;
}

export function buildEarlyExitSpend(opts: {
  lockTxid: string;
  lockVout: number;
  lockAmount: bigint;
  lockScriptPubKey: Uint8Array;
  witnessScript: Uint8Array;
  preimage: Uint8Array;
  needsFiller: boolean;
  privateKey: Uint8Array;
  to: string;
  feeSats: bigint;
  network: typeof btc.NETWORK;
}): EarlyExitSpend {
  const outputSats = opts.lockAmount - opts.feeSats;
  const tx = new btc.Transaction({ allowUnknownInputs: true });
  tx.addInput({
    txid: opts.lockTxid,
    index: opts.lockVout,
    witnessUtxo: { script: opts.lockScriptPubKey, amount: opts.lockAmount },
  });
  tx.addOutputAddress(opts.to, outputSats, opts.network);

  const sighash = tx.preimageWitnessV0(0, opts.witnessScript, btc.SigHash.ALL, opts.lockAmount);
  const sig = new Uint8Array([...signECDSA(sighash, opts.privateKey), btc.SigHash.ALL]);

  // OP_ELSE branch witness, bottom->top (last item is the witnessScript). The shared OP_VERIFY
  // after OP_ENDIF needs a truthy item: a CHECKSIGVERIFY (ad) early-unlock leaves nothing, so a
  // 0x01 filler is inserted below the early-unlock signature; a CHECKSIG (ac) leaves its own
  // boolean and needs no filler. Both signature slots are the same key over the same sighash.
  const empty = new Uint8Array(0);
  const witness = opts.needsFiller
    ? [sig, Uint8Array.of(0x01), sig, opts.preimage, empty, opts.witnessScript]
    : [sig, sig, opts.preimage, empty, opts.witnessScript];
  tx.updateInput(0, { finalScriptWitness: witness }, true);

  return { txid: tx.id, txHex: tx.hex, outputSats };
}

export interface ParsedOutput {
  script: Uint8Array;
  amount: bigint;
}

export function parseTxOutput(txHex: string, vout: number): ParsedOutput {
  const tx = btc.Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
  if (vout >= tx.outputsLength) {
    throw new CliError(`output index ${vout} is out of range (transaction has ${tx.outputsLength} outputs)`);
  }
  const out = tx.getOutput(vout);
  return { script: out.script!, amount: out.amount! };
}
