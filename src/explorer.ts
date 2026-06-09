import type { Config } from './config.js';
import { link } from './output.js';

function stacksParams(config: Config): string {
  return new URLSearchParams({ chain: config.explorerChain, api: config.stacksApiUrl }).toString();
}

export function explorerAddressUrl(config: Config, principal: string): string {
  return `${config.explorerUrl}/address/${principal}?${stacksParams(config)}`;
}

export function explorerLink(config: Config, principal: string, label = principal): string {
  return link(explorerAddressUrl(config, principal), label);
}

export function explorerTxUrl(config: Config, txid: string): string {
  return `${config.explorerUrl}/txid/${txid}?${stacksParams(config)}`;
}

export function explorerTxLink(config: Config, txid: string, label = txid): string {
  return link(explorerTxUrl(config, txid), label);
}

function bitcoinWebBase(config: Config): string {
  return config.bitcoinApiUrl.replace(/\/api$/, '');
}

export function bitcoinTxUrl(config: Config, txid: string): string {
  return `${bitcoinWebBase(config)}/tx/${txid}`;
}

export function bitcoinTxLink(config: Config, txid: string, label = txid): string {
  return link(bitcoinTxUrl(config, txid), label);
}

export function bitcoinAddressUrl(config: Config, address: string): string {
  return `${bitcoinWebBase(config)}/address/${address}`;
}

export function bitcoinAddressLink(config: Config, address: string, label = address): string {
  return link(bitcoinAddressUrl(config, address), label);
}
