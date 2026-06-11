import { createHash } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { pushCScriptNum, toConsensusBuffStandardPrincipal } from '@stacks/bitcoin-staking';
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

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function buildLockupScript(opts: {
  stxAddress: string;
  unlockHeight: number;
  stakerUnlockBytes: Uint8Array;
  earlyUnlockBytes: Uint8Array | string;
}): Uint8Array {
  const stakerCommitment = sha256(sha256(toConsensusBuffStandardPrincipal(opts.stxAddress)));
  const earlyUnlockBytes =
    typeof opts.earlyUnlockBytes === 'string' ? hexToBytes(opts.earlyUnlockBytes) : opts.earlyUnlockBytes;
  const parts = [
    Uint8Array.of(0x63),
    pushCScriptNum(opts.unlockHeight),
    Uint8Array.of(0xb1, 0x67, 0x82, 0x01, 0x20, 0x88, 0xa8, 0x20),
    stakerCommitment,
    Uint8Array.of(0x88),
    earlyUnlockBytes,
    Uint8Array.of(0x68, 0x69),
    opts.stakerUnlockBytes,
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
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
