import type { Config } from './config.js';
import { link } from './output.js';

export function explorerAddressUrl(config: Config, principal: string): string {
  const params = new URLSearchParams({ chain: config.explorerChain, api: config.stacksApiUrl });
  return `${config.explorerUrl}/address/${principal}?${params.toString()}`;
}

export function explorerLink(config: Config, principal: string, label = principal): string {
  return link(explorerAddressUrl(config, principal), label);
}
