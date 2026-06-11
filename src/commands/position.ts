import {
  fetchAccountStatus,
  fetchBondMembership,
  fetchPoxInfo,
  fetchStakerInfo,
} from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { resolveStxAddress } from '../address.js';
import { fetchBtcBalanceSats } from '../btc.js';
import { CliError } from '../errors.js';
import { explorerLink } from '../explorer.js';
import { fetchSbtcBalance } from '../pox.js';
import { output, printNote, printRows, printSection, sats, sbtc, stx, type Row } from '../output.js';

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;

interface StakerBondPosition {
  registeredSats: bigint;
  lockedSats: bigint;
  earlyExitedSats: bigint;
  unstakedSats: bigint;
  isL1: boolean;
  truncated: boolean;
}

export async function positionCommand(ctx: Ctx, addressArg?: string): Promise<void> {
  const address = resolveStxAddress(ctx, addressArg);
  const btcAddress =
    (!addressArg || addressArg === ctx.config.stxAddress) && ctx.config.btcAddress
      ? ctx.config.btcAddress
      : undefined;

  const [pox, account, staker, bond, sbtcBalance, btcSats] = await Promise.all([
    fetchPoxInfo(ctx.net),
    fetchAccountStatus({ address, ...ctx.net }),
    fetchStakerInfo({ address, ...ctx.net }),
    fetchBondMembership({ address, ...ctx.net }),
    fetchSbtcBalance(ctx, address),
    btcAddress ? fetchBtcBalanceSats(ctx.config, btcAddress) : Promise.resolve(undefined),
  ]);

  const liquid = account.balance - account.locked;
  const bondPosition = bond ? await scanStakerBondPosition(ctx, bond.bondIndex, address) : undefined;

  output(
    ctx,
    {
      address,
      bitcoinBlockHeight: pox.currentBurnchainBlockHeight,
      account: {
        balance: account.balance,
        locked: account.locked,
        liquid,
        unlockHeight: account.unlockHeight,
        nonce: account.nonce,
      },
      sbtc: sbtcBalance ? { contractId: sbtcBalance.contractId, balanceSats: sbtcBalance.balance } : null,
      btc: btcAddress ? { address: btcAddress, balanceSats: btcSats ?? null } : null,
      stxOnly: staker.staked ? staker.details : null,
      bond: bond
        ? {
            ...bond,
            registeredSats: bondPosition?.registeredSats ?? null,
            lockedSats: bondPosition?.lockedSats ?? null,
            earlyExitedSats: bondPosition?.earlyExitedSats ?? null,
            unstakedSats: bondPosition?.unstakedSats ?? null,
          }
        : null,
    },
    () => {
      printSection(`Position — ${explorerLink(ctx.config, address)}`);
      const balanceRows: Row[] = [
        ['STX balance', stx(account.balance)],
        ['STX locked', stx(account.locked)],
        ['STX liquid', stx(liquid)],
        ['sBTC', sbtcBalance ? sbtc(sbtcBalance.balance) : null],
      ];
      if (btcAddress) balanceRows.push(['BTC', btcSats === undefined ? null : sats(btcSats)]);
      balanceRows.push(['unlock height', account.unlockHeight === 0 ? 'not locked' : account.unlockHeight]);
      balanceRows.push(['nonce', account.nonce]);
      printRows(balanceRows);

      printSection('STX-only stake');
      if (staker.staked) {
        const d = staker.details;
        printRows([
          ['amount', stx(d.amountUstx)],
          ['first reward cycle', d.firstRewardCycle],
          ['num cycles', d.numCycles],
          ['signer-manager', explorerLink(ctx.config, d.signer)],
        ]);
      } else {
        printRows([['status', 'none']]);
      }

      printSection('Paired bond');
      if (bond) {
        const rows: Row[] = [
          ['bond index', bond.bondIndex],
          ['paired STX', stx(bond.amountUstx)],
        ];
        if (bondPosition) {
          rows.push([bond.isL1Lock ? 'locked BTC' : 'locked sBTC', sats(bondPosition.lockedSats)]);
          if (bondPosition.earlyExitedSats > 0n) rows.push(['early-exited', sats(bondPosition.earlyExitedSats)]);
          if (bondPosition.unstakedSats > 0n) rows.push(['unstaked', sats(bondPosition.unstakedSats)]);
        }
        rows.push(['signer-manager', explorerLink(ctx.config, bond.signer)]);
        rows.push(['lock type', bond.isL1Lock ? 'native BTC (L1 timelock)' : 'sBTC (L2)']);
        printRows(rows);
        if (bondPosition?.truncated) {
          printNote(`event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — locked amount may be incomplete`);
        }
      } else {
        printRows([['status', 'none']]);
      }
    },
  );
}

async function scanStakerBondPosition(
  ctx: Ctx,
  bondIndex: number,
  staker: string,
): Promise<StakerBondPosition | undefined> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  let registered: { sats: bigint; isL1: boolean } | undefined;
  let released = 0n;
  let sbtcRemaining: bigint | undefined;
  let offset = 0;
  let truncated = true;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as { results?: { contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      const f = tupleFields(ev.contract_log?.value?.hex);
      if (!f || !f['topic'] || !f['bond-index'] || !f['staker']) continue;
      if (cvToValue(f['staker']) !== staker) continue;
      if (Number((f['bond-index'] as { value: bigint }).value) !== bondIndex) continue;
      const topic = cvToValue(f['topic']);
      // events arrive newest-first, so the first seen per topic is the most recent
      if (topic === 'register-for-bond') {
        if (!registered) {
          registered = {
            sats: (f['sats-total'] as { value: bigint }).value,
            isL1: cvToValue(f['is-l1-lock']!) === true,
          };
        }
      } else if (topic === 'announce-l1-early-exit') {
        released += (f['amount-sats-released'] as { value: bigint }).value;
      } else if (topic === 'unstake-sbtc' && sbtcRemaining === undefined) {
        sbtcRemaining = (f['new-amount-sats'] as { value: bigint }).value;
      }
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) {
      truncated = false;
      break;
    }
  }

  if (!registered) return undefined;
  let lockedSats: bigint;
  let earlyExitedSats = 0n;
  let unstakedSats = 0n;
  if (registered.isL1) {
    earlyExitedSats = released > registered.sats ? registered.sats : released;
    lockedSats = registered.sats - earlyExitedSats;
  } else {
    lockedSats = sbtcRemaining ?? registered.sats;
    unstakedSats = registered.sats > lockedSats ? registered.sats - lockedSats : 0n;
  }
  return { registeredSats: registered.sats, lockedSats, earlyExitedSats, unstakedSats, isL1: registered.isL1, truncated };
}

function tupleFields(hex: string | undefined): Record<string, ClarityValue> | undefined {
  if (!hex) return undefined;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return undefined;
  }
  if (cv.type !== ClarityType.Tuple) return undefined;
  return (cv as { value: Record<string, ClarityValue> }).value;
}
