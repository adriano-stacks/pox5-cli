import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  bondPhaseRanges,
  burnHeightToDistributionIndex,
  burnHeightToRewardCycle,
  currentDistributionCycle,
  distributionCycleToBurnHeight,
  fetchBondAllowance,
  fetchBondL1UnlockHeight,
  fetchPoxInfo,
  fetchTotalSbtcStakedForBond,
  type BondPhaseName,
  type PoxInfo,
} from '@stacks/bitcoin-staking';
import { ClarityType, cvToValue, hexToCV, type ClarityValue } from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { explorerLink } from '../explorer.js';
import { fetchBondConfig, resolveFirstPox5Cycle, withFirstPox5Cycle } from '../pox.js';
import { bitcoinBlocks, bps, dim, output, percent, printNote, printRows, printSection, sats, type Row } from '../output.js';

const BOND_END_OFFSET_PERIODS = 6;

interface RewardsTiming {
  distLen: number;
  windowStartHeight: number;
  windowEndHeight: number;
  count: number;
  firstHeight: number;
  firstCycle: number;
  lastHeight: number;
  lastCycle: number;
  next?: { height: number; cycle: number; runnableAt: number; runnableNow: boolean };
}

function rewardsTiming(p: PoxInfo, bondIndex: number, now: number): RewardsTiming {
  const distLen = Math.floor(p.rewardCycleLength / 2);
  const calcHeightOf = (d: number) => distributionCycleToBurnHeight({ distributionCycle: d, poxInfo: p }) - 1;
  const cycleOf = (h: number) => burnHeightToRewardCycle({ burnHeight: h, poxInfo: p });
  const windowStartHeight = bondPeriodToBurnHeight({ bondIndex, poxInfo: p });
  const windowEndHeight = bondPeriodToBurnHeight({ bondIndex: bondIndex + BOND_END_OFFSET_PERIODS, poxInfo: p });

  // a distribution at calc height H credits this bond iff windowStart < H <= windowEnd
  let firstD = burnHeightToDistributionIndex({ burnHeight: windowStartHeight, poxInfo: p });
  while (calcHeightOf(firstD) <= windowStartHeight) firstD++;
  let lastD = burnHeightToDistributionIndex({ burnHeight: windowEndHeight, poxInfo: p });
  while (calcHeightOf(lastD) > windowEndHeight) lastD--;
  while (calcHeightOf(lastD + 1) <= windowEndHeight) lastD++;
  const count = Math.max(0, lastD - firstD + 1);

  const firstHeight = calcHeightOf(firstD);
  const lastHeight = calcHeightOf(lastD);

  let next: RewardsTiming['next'];
  const nd = Math.max(firstD, currentDistributionCycle(p));
  if (count > 0 && nd <= lastD) {
    const height = calcHeightOf(nd);
    next = { height, cycle: cycleOf(height), runnableAt: height + 1, runnableNow: now >= height + 1 };
  }

  return {
    distLen,
    windowStartHeight,
    windowEndHeight,
    count,
    firstHeight,
    firstCycle: cycleOf(firstHeight),
    lastHeight,
    lastCycle: cycleOf(lastHeight),
    next,
  };
}

function nextDistributionText(r: RewardsTiming, now: number): string {
  if (!r.next) return r.count > 0 ? `reward window closed (last at calc height ${r.lastHeight})` : 'none';
  const { height, cycle, runnableAt, runnableNow } = r.next;
  if (runnableNow) return `calc height ${height} (settles cycle ${cycle}) — runnable now`;
  return `calc height ${height} (settles cycle ${cycle}) — runnable once Bitcoin ≥ ${runnableAt} (in ${bitcoinBlocks(runnableAt - now)})`;
}

const EVENT_PAGE_SIZE = 50;
const EVENT_MAX_PAGES = 100;

export interface BondOpts {
  addresses?: string[];
  allowlist?: boolean;
}

interface AllowlistEntry {
  staker: string;
  maxSats: bigint;
}

interface FillBreakdown {
  btcSats: bigint;
  sbtcSats: bigint;
  participants: number;
  truncated: boolean;
  earlyExitedSats: bigint;
  earlyExitParticipants: number;
  unstakedSats: bigint;
  unstakeParticipants: number;
  byStaker: Map<string, { sats: bigint; isL1: boolean; earlyExitedSats: bigint; unstakedSats: bigint }>;
}

function phaseAt(burnHeight: number, pox: PoxInfo, bondIndex: number): BondPhaseName | 'pre-announce' | 'ended' {
  const ranges = bondPhaseRanges({ bondIndex, poxInfo: pox });
  if (ranges.length === 0 || burnHeight < ranges[0]!.startBurnHeight) return 'pre-announce';
  for (const r of ranges) {
    if (burnHeight >= r.startBurnHeight && burnHeight < r.endBurnHeight) return r.name;
  }
  return 'ended';
}

export async function bondCommand(ctx: Ctx, bondIndex: number, opts: BondOpts): Promise<void> {
  const [pox, bond, filledSbtc] = await Promise.all([
    fetchPoxInfo(ctx.net),
    fetchBondConfig(ctx, bondIndex),
    fetchTotalSbtcStakedForBond({ bondIndex, ...ctx.net }),
  ]);

  if (!bond) throw new CliError(`bond ${bondIndex} is not configured on this contract`);

  const fill = await scanBondFill(ctx, bondIndex);
  const splitSum = fill.btcSats + fill.sbtcSats;

  const allowanceAddresses =
    opts.addresses && opts.addresses.length > 0
      ? opts.addresses
      : ctx.config.stxAddress
        ? [ctx.config.stxAddress]
        : [];
  const allowances = await Promise.all(
    allowanceAddresses.map(async (address) => ({
      address,
      allocationSats: await fetchBondAllowance({ bondIndex, address, ...ctx.net }),
      filledSats: fill.byStaker.get(address)?.sats ?? 0n,
      earlyExitedSats: fill.byStaker.get(address)?.earlyExitedSats ?? 0n,
      unstakedSats: fill.byStaker.get(address)?.unstakedSats ?? 0n,
    })),
  );

  let allowlist: AllowlistEntry[] | undefined;
  let allowlistTruncated = false;
  let capacitySats: bigint | undefined;
  if (opts.allowlist) {
    const scan = await scanBondAllowlist(ctx, bondIndex);
    allowlist = scan.entries;
    allowlistTruncated = scan.truncated;
    capacitySats = allowlist.reduce((sum, e) => sum + e.maxSats, 0n);
  }

  const firstPox5 = resolveFirstPox5Cycle(ctx, pox);
  let schedule:
    | {
        firstRewardCycle: number;
        openBitcoinBlockHeight: number;
        status: string;
        l1UnlockHeight: bigint;
        rewards: RewardsTiming;
      }
    | undefined;
  if (firstPox5 !== undefined) {
    const p = withFirstPox5Cycle(pox, firstPox5);
    schedule = {
      firstRewardCycle: bondPeriodToRewardCycle({ bondIndex, poxInfo: p }),
      openBitcoinBlockHeight: bondPeriodToBurnHeight({ bondIndex, poxInfo: p }),
      status: phaseAt(pox.currentBurnchainBlockHeight, p, bondIndex),
      l1UnlockHeight: await fetchBondL1UnlockHeight({ bondIndex, ...ctx.net }),
      rewards: rewardsTiming(p, bondIndex, pox.currentBurnchainBlockHeight),
    };
  }

  output(
    ctx,
    {
      bondIndex: bond.bondIndex,
      targetRateBps: bond.targetRateBps,
      stxValueRatio: bond.stxValueRatio,
      minUstxRatioBps: bond.minUstxRatioBps,
      earlyUnlockBytes: bond.earlyUnlockBytes,
      filledSats: filledSbtc,
      filledBtcLockedSats: fill.btcSats,
      filledSbtcLockedSats: fill.sbtcSats,
      participants: fill.participants,
      earlyExitedSats: fill.earlyExitedSats,
      earlyExitParticipants: fill.earlyExitParticipants,
      unstakedSats: fill.unstakedSats,
      unstakeParticipants: fill.unstakeParticipants,
      capacitySats: capacitySats ?? null,
      allowlist: allowlist ?? null,
      allowlistTruncated: allowlistTruncated || undefined,
      allowances,
      schedule: schedule ?? null,
    },
    () => {
      printSection(`Bond ${bondIndex}`);
      const rows: Row[] = [
        ['target rate', bps(bond.targetRateBps)],
        ['stx value ratio', `${bond.stxValueRatio} uSTX / 100 sats`],
        ['min stx ratio', bps(bond.minUstxRatioBps)],
        ['early-unlock bytes', `${bond.earlyUnlockBytes.length / 2} bytes (${bond.earlyUnlockBytes})`],
      ];
      if (capacitySats !== undefined) {
        rows.push(['capacity', sats(capacitySats)]);
        rows.push(['filled', `${sats(filledSbtc)} — ${percent(filledSbtc, capacitySats)} of capacity`]);
      } else {
        rows.push(['filled', sats(filledSbtc)]);
      }
      rows.push(['  via L1 BTC', sats(fill.btcSats)]);
      rows.push(['  via sBTC', sats(fill.sbtcSats)]);
      if (fill.earlyExitedSats > 0n) {
        const n = fill.earlyExitParticipants;
        rows.push(['early-exited (L1)', `${sats(fill.earlyExitedSats)} — ${n} staker${n === 1 ? '' : 's'}`]);
      }
      if (fill.unstakedSats > 0n) {
        const n = fill.unstakeParticipants;
        rows.push(['unstaked (sBTC)', `${sats(fill.unstakedSats)} — ${n} staker${n === 1 ? '' : 's'}`]);
      }
      for (const a of allowances) {
        rows.push(['allowance', explorerLink(ctx.config, a.address)]);
        rows.push(['  allocation', sats(a.allocationSats)]);
        rows.push(['  filled', `${sats(a.filledSats)} — ${percent(a.filledSats, a.allocationSats)} of allocation`]);
        if (a.earlyExitedSats > 0n) rows.push(['  early-exited', sats(a.earlyExitedSats)]);
        if (a.unstakedSats > 0n) rows.push(['  unstaked', sats(a.unstakedSats)]);
      }
      printRows(rows);
      if (splitSum !== filledSbtc) {
        printNote(
          `custody split is reconstructed from register / unstake-sbtc / announce-l1-early-exit events and sums to ${sats(splitSum)}, which differs from the live "filled" total — e.g. rollovers between bonds aren't accounted for`,
        );
      }
      if (fill.truncated) {
        printNote(`participant event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — custody split may be incomplete`);
      }

      if (allowlist) {
        printSection(`Allowlist — ${allowlist.length} staker${allowlist.length === 1 ? '' : 's'}`);
        if (allowlist.length === 0) {
          printNote('no allowlist entries found in this contract’s events');
        } else {
          for (const e of allowlist) {
            process.stdout.write(`  ${dim('•')} ${explorerLink(ctx.config, e.staker)} ${dim('→')} ${sats(e.maxSats)}\n`);
          }
        }
        if (allowlistTruncated) {
          printNote(`event scan stopped at ${EVENT_MAX_PAGES * EVENT_PAGE_SIZE} events — allowlist may be incomplete`);
        }
      }

      printSection('Schedule');
      if (schedule) {
        printRows([
          ['status', schedule.status],
          ['first reward cycle', schedule.firstRewardCycle],
          ['open Bitcoin block height', schedule.openBitcoinBlockHeight],
          ['L1 unlock height', schedule.l1UnlockHeight],
        ]);

        const r = schedule.rewards;
        const now = pox.currentBurnchainBlockHeight;
        printSection('Rewards distribution (waterfall)');
        printRows([
          ['cadence', `every ${bitcoinBlocks(r.distLen)} (twice per reward cycle)`],
          ['credited at calc height', `${r.windowStartHeight + 1} → ${r.windowEndHeight}`],
          ['distributions', r.count > 0 ? `${r.count}, settling reward cycles ${r.firstCycle} → ${r.lastCycle}` : 'none — bond never active for a distribution'],
          ['first distribution', r.count > 0 ? `calc height ${r.firstHeight} → settles cycle ${r.firstCycle}` : null],
          ['next distribution', nextDistributionText(r, now)],
        ]);
        printNote(
          `a calculate-rewards run only credits this bond when its calculation height H satisfies ` +
            `${r.windowStartHeight} < H ≤ ${r.windowEndHeight}; include bond ${bondIndex} (canonical order) in --bond, ` +
            `and fund the contract with unaccounted sBTC before that run`,
        );
      } else {
        printNote('unavailable — set POX5_FIRST_POX5_CYCLE / --first-pox5-cycle to derive');
      }
    },
  );
}

async function scanBondFill(ctx: Ctx, bondIndex: number): Promise<FillBreakdown> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const registered = new Map<string, { sats: bigint; isL1: boolean }>();
  const l1Released = new Map<string, bigint>();
  const sbtcRemaining = new Map<string, bigint>();
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
      const topic = cvToValue(f['topic']);
      if (topic !== 'register-for-bond' && topic !== 'announce-l1-early-exit' && topic !== 'unstake-sbtc') continue;
      if (Number((f['bond-index'] as { value: bigint }).value) !== bondIndex) continue;
      const staker = cvToValue(f['staker']) as string;
      // events arrive newest-first, so the first seen per staker is the most recent
      if (topic === 'register-for-bond') {
        if (!registered.has(staker)) {
          registered.set(staker, {
            sats: (f['sats-total'] as { value: bigint }).value,
            isL1: cvToValue(f['is-l1-lock']!) === true,
          });
        }
      } else if (topic === 'announce-l1-early-exit') {
        l1Released.set(staker, (l1Released.get(staker) ?? 0n) + (f['amount-sats-released'] as { value: bigint }).value);
      } else if (!sbtcRemaining.has(staker)) {
        sbtcRemaining.set(staker, (f['new-amount-sats'] as { value: bigint }).value);
      }
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) {
      truncated = false;
      break;
    }
  }

  const byStaker = new Map<string, { sats: bigint; isL1: boolean; earlyExitedSats: bigint; unstakedSats: bigint }>();
  let btcSats = 0n;
  let sbtcSats = 0n;
  let participants = 0;
  let earlyExitedSats = 0n;
  let earlyExitParticipants = 0;
  let unstakedSats = 0n;
  let unstakeParticipants = 0;
  for (const [staker, reg] of registered) {
    let current: bigint;
    let exited = 0n;
    let unstaked = 0n;
    if (reg.isL1) {
      const released = l1Released.get(staker) ?? 0n;
      exited = released > reg.sats ? reg.sats : released;
      current = reg.sats - exited;
    } else {
      current = sbtcRemaining.has(staker) ? sbtcRemaining.get(staker)! : reg.sats;
      unstaked = reg.sats > current ? reg.sats - current : 0n;
    }
    byStaker.set(staker, { sats: current, isL1: reg.isL1, earlyExitedSats: exited, unstakedSats: unstaked });
    if (exited > 0n) {
      earlyExitedSats += exited;
      earlyExitParticipants += 1;
    }
    if (unstaked > 0n) {
      unstakedSats += unstaked;
      unstakeParticipants += 1;
    }
    if (current <= 0n) continue;
    participants += 1;
    if (reg.isL1) btcSats += current;
    else sbtcSats += current;
  }
  return {
    btcSats,
    sbtcSats,
    participants,
    truncated,
    earlyExitedSats,
    earlyExitParticipants,
    unstakedSats,
    unstakeParticipants,
    byStaker,
  };
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

async function scanBondAllowlist(
  ctx: Ctx,
  bondIndex: number,
): Promise<{ entries: AllowlistEntry[]; truncated: boolean }> {
  const contractId = `${ctx.net.network.bootAddress}.pox-5`;
  const byStaker = new Map<string, bigint>();
  let offset = 0;

  for (let page = 0; page < EVENT_MAX_PAGES; page++) {
    const url = `${ctx.config.extendedApiUrl}/v1/contract/${contractId}/events?limit=${EVENT_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new CliError(`pox-5 events request failed (HTTP ${res.status})`);
    const results = ((await res.json()) as { results?: { contract_log?: { value?: { hex?: string } } }[] }).results ?? [];
    for (const ev of results) {
      const e = allowlistFromEventHex(ev.contract_log?.value?.hex, bondIndex);
      if (e && !byStaker.has(e.staker)) byStaker.set(e.staker, e.maxSats);
    }
    offset += EVENT_PAGE_SIZE;
    if (results.length < EVENT_PAGE_SIZE) {
      return { entries: sortBySats(byStaker), truncated: false };
    }
  }
  return { entries: sortBySats(byStaker), truncated: true };
}

function allowlistFromEventHex(hex: string | undefined, bondIndex: number): AllowlistEntry | undefined {
  if (!hex) return undefined;
  let cv: ClarityValue;
  try {
    cv = hexToCV(hex);
  } catch {
    return undefined;
  }
  if (cv.type !== ClarityType.Tuple) return undefined;
  const f = (cv as { value: Record<string, ClarityValue> }).value;
  if (!f['topic'] || cvToValue(f['topic']) !== 'add-to-allowlist') return undefined;
  if (Number((f['bond-index']! as { value: bigint }).value) !== bondIndex) return undefined;
  return {
    staker: cvToValue(f['staker']!) as string,
    maxSats: (f['max-sats']! as { value: bigint }).value,
  };
}

function sortBySats(byStaker: Map<string, bigint>): AllowlistEntry[] {
  return [...byStaker.entries()]
    .map(([staker, maxSats]) => ({ staker, maxSats }))
    .sort((a, b) => (b.maxSats > a.maxSats ? 1 : b.maxSats < a.maxSats ? -1 : a.staker.localeCompare(b.staker)));
}
