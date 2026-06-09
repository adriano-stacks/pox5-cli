import {
  STACKS_DEVNET,
  STACKS_MAINNET,
  STACKS_TESTNET,
  type StacksNetwork,
} from '@stacks/network';
import { CliError } from './errors.js';

const DEFAULTS = {
  stacksApiUrl: 'https://api.private-1.hiro.so',
  extendedApiUrl: 'https://api.private-1.hiro.so/extended',
  bitcoinApiUrl: 'https://mempool.bitcoin.private-1.hiro.so/api',
  explorerUrl: 'https://explorer.hiro.so',
  explorerChain: 'mainnet',
  chainId: 256,
  bootAddress: 'ST000000000000000000002AMW42H',
  networkBase: 'testnet' as const,
};

export interface CliOverrides {
  apiUrl?: string;
  extendedUrl?: string;
  bitcoinUrl?: string;
  explorerUrl?: string;
  bootAddress?: string;
  chainId?: number;
  networkBase?: string;
  firstPox5Cycle?: number;
}

export interface Config {
  network: StacksNetwork;
  stacksApiUrl: string;
  extendedApiUrl: string;
  bitcoinApiUrl: string;
  explorerUrl: string;
  explorerChain: string;
  stxAddress?: string;
  btcAddress?: string;
  firstPox5Cycle?: number;
}

function baseNetwork(name: string): StacksNetwork {
  switch (name) {
    case 'mainnet':
      return STACKS_MAINNET;
    case 'devnet':
    case 'mocknet':
      return STACKS_DEVNET;
    case 'testnet':
      return STACKS_TESTNET;
    default:
      throw new CliError(`unknown network base "${name}" (expected mainnet | testnet | devnet)`);
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`env ${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

export function loadConfig(overrides: CliOverrides = {}): Config {
  const networkBase = overrides.networkBase ?? process.env.POX5_NETWORK_BASE ?? DEFAULTS.networkBase;
  const base = baseNetwork(networkBase);

  const stacksApiUrl = stripTrailingSlash(
    overrides.apiUrl ?? process.env.POX5_STACKS_API_URL ?? DEFAULTS.stacksApiUrl,
  );
  const extendedApiUrl = stripTrailingSlash(
    overrides.extendedUrl ?? process.env.POX5_EXTENDED_API_URL ?? DEFAULTS.extendedApiUrl,
  );
  const bitcoinApiUrl = stripTrailingSlash(
    overrides.bitcoinUrl ?? process.env.POX5_BITCOIN_API_URL ?? DEFAULTS.bitcoinApiUrl,
  );
  const explorerUrl = stripTrailingSlash(
    overrides.explorerUrl ?? process.env.POX5_EXPLORER_URL ?? DEFAULTS.explorerUrl,
  );
  const explorerChain = process.env.POX5_EXPLORER_CHAIN ?? DEFAULTS.explorerChain;
  const chainId = overrides.chainId ?? envInt('POX5_CHAIN_ID') ?? DEFAULTS.chainId;
  const bootAddress =
    overrides.bootAddress ?? process.env.POX5_BOOT_ADDRESS ?? base.bootAddress ?? DEFAULTS.bootAddress;
  const firstPox5Cycle = overrides.firstPox5Cycle ?? envInt('POX5_FIRST_POX5_CYCLE');
  const stxAddress = process.env.POX5_STX_ADDRESS || undefined;
  const btcAddress = process.env.POX5_BTC_ADDRESS || undefined;

  const network: StacksNetwork = {
    ...base,
    chainId,
    bootAddress,
    client: { ...base.client, baseUrl: stacksApiUrl },
  };

  return { network, stacksApiUrl, extendedApiUrl, bitcoinApiUrl, explorerUrl, explorerChain, stxAddress, btcAddress, firstPox5Cycle };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
