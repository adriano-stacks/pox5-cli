import type { Ctx } from './context.js';

type ApiInteger = number | string;

interface CursorPage<T> {
  cursor: { next: string | null };
  results: T[];
}

interface IndexedTransactionPosition {
  tx_id: string;
  event_index: number;
}

interface IndexedBlockPosition {
  height: number;
  hash: string;
  index_hash: string;
  time: number;
  tx_index: number;
}

interface IndexedBitcoinBlockPosition {
  height: number;
  time: number;
}

export interface IndexedBond {
  index: number;
  pox_version: 'pox5';
  status: 'upcoming' | 'active' | 'unlocked';
  parameters: {
    target_rate_bps: number;
    stx_value_ratio: ApiInteger;
    minimum_stx_ratio: ApiInteger;
    btc_capacity: string;
  };
  registrations: { allowed_count: number; registered_count: number };
  schedule: {
    activation: { bitcoin_height: number; pox_cycle: number };
    unlock: { bitcoin_height: number; pox_cycle: number };
  };
  balances: {
    locked: { btc: string; stx: string };
    paid_out: { btc: string };
  };
  transaction?: {
    tx_id: string;
    bitcoin_block: { height: number; time: number };
  };
}

export interface IndexedBondRegistration {
  staker: string;
  signer: string;
  type: 'l1' | 'l2';
  balances: { btc: string; stx: string };
  l1_lockup?: { transactions: { tx_id: string; output_index: number }[] };
  l2_lockup?: { tx_id: string };
}

interface IndexedBondEventBase {
  bond_index: number;
  transaction: IndexedTransactionPosition;
  block: IndexedBlockPosition;
  bitcoin_block: IndexedBitcoinBlockPosition;
}

export type IndexedBondEvent = IndexedBondEventBase & (
  | {
      name: 'register-for-bond';
      data: IndexedBondRegistration;
    }
  | {
      name: 'update-bond-registration';
      data: IndexedBondRegistration & { old_signer: string };
    }
  | {
      name: 'announce-l1-early-exit';
      data: { staker: string; signer: string; released: { btc: string } };
    }
  | {
      name: 'unstake-sbtc';
      data: {
        staker: string;
        signer: string;
        withdrawn: { btc: string };
        remaining: { btc: string };
      };
    }
  | {
      name: 'bond-distribution';
      data: {
        target_yield: string;
        rewards: { btc: string };
        staked: { btc: string };
        accrued_rewards_per_sat: string;
        cumulative_rewards_per_sat: string;
      };
    }
  | {
      name: 'claim-staker-rewards-for-signer';
      data: {
        signer_manager: string;
        staker: string;
        reward_cycle: number;
        claimed: { btc: string };
      };
    }
  | {
      name: 'setup-bond' | 'add-to-allowlist';
      data: Record<string, unknown>;
    }
);

export interface IndexedBondPosition {
  bond_index: number;
  status: 'enrolled' | 'running' | 'early_exit' | 'unlocked';
  active: boolean;
  enrollment: { tx_id: string; btc_lockup: { amount: string } };
  locked: { btc: string; stx: string };
  rewards: { btc: IndexedRewards };
}

export interface IndexedStakingSummary {
  stx: { locked: string; rewards: { btc: IndexedRewards } };
  bonds: {
    count: number;
    locked: { btc: string; stx: string };
    rewards: { btc: IndexedRewards };
  };
}

interface IndexedRewards {
  accrued: string;
  claimed: string;
  claimable: string;
}

export interface IndexedSigner {
  signer: string;
  signer_key: string;
  transaction?: {
    tx_id: string;
    bitcoin_block: { height: number; time: number };
  };
}

export interface IndexedSignerStaker {
  staker: string;
  types: ('stx' | 'btc')[];
}

export interface IndexedSignerKeyGrant {
  signer_key: string;
  auth_id: string;
  tx_id: string;
}

export interface IndexedCycleSignerManager {
  signer_manager: string;
  registered_at: {
    block_height: number;
    bitcoin_block_height: number;
    tx_id: string;
  };
  granted_keys: IndexedSignerKeyGrant[];
  grant_active: boolean;
  pending_key_update: null | {
    signer_key: string;
    effective_cycle: number;
    tx_id: string;
  };
}

export interface IndexedCycleSigner {
  signing_key: string;
  weight: { amount: number; percent: number };
  staked_stx: { amount: string; percent: number };
  signer_managers: IndexedCycleSignerManager[];
}

export interface IndexedStakingRewards {
  btc: {
    reward_amount: string;
    burn_amount: string;
    total_amount: string;
  };
}

export interface IndexedStxBalance {
  balance: string;
  available: string;
  locked: null | { amount: string; burn_unlock_height: number };
}

export interface IndexedAllowlistEntry {
  staker: string;
  max_sats: string;
}

export function fetchIndexedBonds(ctx: Ctx): Promise<IndexedBond[] | undefined> {
  return fetchAll(ctx, '/v3/staking/bonds', 50);
}

export function fetchIndexedBond(ctx: Ctx, bondIndex: number): Promise<IndexedBond | undefined> {
  return fetchJson(ctx, `/v3/staking/bonds/${bondIndex}`);
}

export function fetchIndexedBondRegistrations(
  ctx: Ctx,
  bondIndex: number,
): Promise<IndexedBondRegistration[] | undefined> {
  return fetchAll(ctx, `/v3/staking/bonds/${bondIndex}/registrations`, 50);
}

export function fetchIndexedBondEvents(
  ctx: Ctx,
  bondIndex: number,
): Promise<IndexedBondEvent[] | undefined> {
  return fetchAll(ctx, `/v3/staking/bonds/${bondIndex}/events`, 50);
}

export function fetchIndexedBondAllowlist(
  ctx: Ctx,
  bondIndex: number,
): Promise<IndexedAllowlistEntry[] | undefined> {
  return fetchAll(ctx, `/v3/staking/bonds/${bondIndex}/allowlist`, 50);
}

export function fetchIndexedBondAllowance(
  ctx: Ctx,
  bondIndex: number,
  principal: string,
): Promise<IndexedAllowlistEntry | undefined> {
  return fetchJson(ctx, `/v3/staking/bonds/${bondIndex}/allowlist/${encodeURIComponent(principal)}`);
}

export function fetchIndexedStakingSummary(
  ctx: Ctx,
  principal: string,
): Promise<IndexedStakingSummary | undefined> {
  return fetchJson(ctx, `/v3/principals/${encodeURIComponent(principal)}/staking`);
}

export function fetchIndexedBondPositions(
  ctx: Ctx,
  principal: string,
): Promise<IndexedBondPosition[] | undefined> {
  return fetchAll(ctx, `/v3/principals/${encodeURIComponent(principal)}/staking/bonds`, 50);
}

export function fetchIndexedSigners(ctx: Ctx): Promise<IndexedSigner[] | undefined> {
  return fetchAll(ctx, '/v3/staking/signers', 250);
}

export function fetchIndexedSigner(ctx: Ctx, principal: string): Promise<IndexedSigner | undefined> {
  return fetchJson(ctx, `/v3/staking/signers/${encodeURIComponent(principal)}`);
}

export function fetchIndexedSignerStakers(
  ctx: Ctx,
  principal: string,
): Promise<IndexedSignerStaker[] | undefined> {
  return fetchAll(ctx, `/v3/staking/signers/${encodeURIComponent(principal)}/stakers`, 200);
}

export function fetchIndexedCurrentCycleSigners(ctx: Ctx): Promise<IndexedCycleSigner[] | undefined> {
  return fetchAll(ctx, '/v3/staking/cycles/current/signers', 100);
}

export function fetchIndexedStakingRewards(ctx: Ctx): Promise<IndexedStakingRewards | undefined> {
  return fetchJson(ctx, '/v3/staking/rewards');
}

export async function fetchIndexedFtBalance(
  ctx: Ctx,
  principal: string,
  assetIdentifier: string,
): Promise<bigint | undefined> {
  const result = await fetchJson<{ balance: string }>(
    ctx,
    `/v3/principals/${encodeURIComponent(principal)}/balances/ft/${encodeURIComponent(assetIdentifier)}`,
  );
  return result === undefined ? undefined : BigInt(result.balance);
}

export function fetchIndexedStxBalance(ctx: Ctx, principal: string): Promise<IndexedStxBalance | undefined> {
  return fetchJson(ctx, `/v3/principals/${encodeURIComponent(principal)}/balances/stx`);
}

export async function fetchIndexedNonce(ctx: Ctx, principal: string): Promise<bigint | undefined> {
  const result = await fetchJson<{ next_nonce: number }>(
    ctx,
    `/v3/principals/${encodeURIComponent(principal)}/nonces`,
  );
  return result === undefined ? undefined : BigInt(result.next_nonce);
}

async function fetchAll<T>(ctx: Ctx, path: string, limit: number): Promise<T[] | undefined> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', cursor);
    const page = await fetchJson<CursorPage<T>>(ctx, `${path}?${params.toString()}`);
    if (page === undefined) return undefined;
    results.push(...page.results);

    const next = page.cursor.next;
    if (next === null || seen.has(next)) return results;
    seen.add(next);
    cursor = next;
  }
}

async function fetchJson<T>(ctx: Ctx, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${ctx.config.extendedApiUrl}${path}`);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
