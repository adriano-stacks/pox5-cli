import type { StacksNetwork } from '@stacks/network';
import { loadConfig, type CliOverrides, type Config } from './config.js';

export interface Ctx {
  config: Config;
  json: boolean;
  net: { network: StacksNetwork; client: { baseUrl: string } };
}

export interface GlobalOpts {
  json?: boolean;
  apiUrl?: string;
  extendedUrl?: string;
  bitcoinUrl?: string;
  explorerUrl?: string;
  bootAddress?: string;
  chainId?: number;
  networkBase?: string;
  firstPox5Cycle?: number;
}

export function buildContext(opts: GlobalOpts): Ctx {
  const overrides: CliOverrides = {
    apiUrl: opts.apiUrl,
    extendedUrl: opts.extendedUrl,
    bitcoinUrl: opts.bitcoinUrl,
    explorerUrl: opts.explorerUrl,
    bootAddress: opts.bootAddress,
    chainId: opts.chainId,
    networkBase: opts.networkBase,
    firstPox5Cycle: opts.firstPox5Cycle,
  };
  const config = loadConfig(overrides);
  return {
    config,
    json: opts.json === true,
    net: { network: config.network, client: { baseUrl: config.stacksApiUrl } },
  };
}
