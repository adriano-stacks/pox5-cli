import {
  bondPeriodToBurnHeight,
  bondPeriodToRewardCycle,
  buildSetupBond,
  fetchPoxInfo,
} from '@stacks/bitcoin-staking';
import {
  TransactionSigner,
  broadcastTransaction,
  cvToString,
  deserializeCV,
  fetchNonce,
  getAddressFromPrivateKey,
  privateKeyToPublic,
  publicKeyToHex,
} from '@stacks/transactions';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveBondAdminPrivateKey } from '../address.js';
import { explorerLink, explorerTxLink } from '../explorer.js';
import { requirePoxWithBondCycle } from '../pox.js';
import { bps, dim, output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const BOND_GAP_CYCLES = 2;
const BOND_LENGTH_CYCLES = 12;

export interface AllowEntry {
  staker: string;
  maxSats: bigint;
}

export interface SetupBondOpts {
  bondIndex: number;
  targetRateBps: number;
  stxValueRatio: bigint;
  minUstxRatioBps: number;
  earlyUnlockBytesHex: string;
  earlyUnlockAdmin: string;
  allowlist: AllowEntry[];
  fee: bigint;
  broadcast: boolean;
}

export async function setupBondCommand(ctx: Ctx, opts: SetupBondOpts): Promise<void> {
  const privateKey = resolveBondAdminPrivateKey();
  const sender = getAddressFromPrivateKey(privateKey, ctx.net.network);
  const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));

  const poxRaw = await fetchPoxInfo(ctx.net);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bondIndex, poxInfo: pox });
  const firstRewardCycle = bondPeriodToRewardCycle({ bondIndex: opts.bondIndex, poxInfo: pox });
  const unlockCycle = firstRewardCycle + BOND_LENGTH_CYCLES;
  const windowOpenHeight = startBurnHeight - BOND_GAP_CYCLES * pox.rewardCycleLength;

  const tooLate = bitcoinHeight >= startBurnHeight;
  const tooSoon = bitcoinHeight < windowOpenHeight;
  if (tooLate) {
    throw new CliError(
      `bond ${opts.bondIndex} can no longer be set up (ERR_CANNOT_SETUP_BOND_TOO_LATE u3): ` +
        `its start height ${startBurnHeight} is at or below the current Bitcoin height ${bitcoinHeight}`,
    );
  }

  const bondAdmin = await fetchBondAdmin(ctx);
  const adminMismatch = bondAdmin !== undefined && bondAdmin !== sender;

  const totalAllowSats = opts.allowlist.reduce((sum, e) => sum + e.maxSats, 0n);
  const nonce = await fetchNonce({ address: sender, ...ctx.net });

  const tx = await buildSetupBond({
    bondIndex: opts.bondIndex,
    targetRateBps: opts.targetRateBps,
    stxValueRatio: opts.stxValueRatio,
    minUstxRatioBps: opts.minUstxRatioBps,
    earlyUnlockSigners: opts.earlyUnlockBytesHex,
    earlyUnlockAdmin: opts.earlyUnlockAdmin,
    allowlist: opts.allowlist,
    publicKey,
    fee: opts.fee,
    nonce,
    network: ctx.net.network,
  });

  const baseRows: Row[] = [
    ['sender', explorerLink(ctx.config, sender)],
    ['bond admin', bondAdmin ? explorerLink(ctx.config, bondAdmin) : null],
    ['target rate', bps(opts.targetRateBps)],
    ['stx value ratio', `${opts.stxValueRatio} uSTX / 100 sats`],
    ['min stx ratio', bps(opts.minUstxRatioBps)],
    ['early-unlock admin', explorerLink(ctx.config, opts.earlyUnlockAdmin)],
    ['early-unlock bytes', `${opts.earlyUnlockBytesHex.length / 2} bytes`],
    ['allowlist', allowlistSummary(opts.allowlist, totalAllowSats)],
    ['fee', stx(opts.fee)],
    ['nonce', nonce],
  ];

  const scheduleRows: Row[] = [
    ['first reward cycle', firstRewardCycle],
    ['bond start height', `${startBurnHeight} (Bitcoin)`],
    ['unlock cycle', unlockCycle],
    ['setup window', windowStatus(bitcoinHeight, windowOpenHeight, startBurnHeight)],
  ];

  const json = {
    sender,
    bondAdmin: bondAdmin ?? null,
    bondIndex: opts.bondIndex,
    targetRateBps: opts.targetRateBps,
    stxValueRatio: opts.stxValueRatio,
    minUstxRatioBps: opts.minUstxRatioBps,
    earlyUnlockBytes: opts.earlyUnlockBytesHex,
    earlyUnlockAdmin: opts.earlyUnlockAdmin,
    allowlist: opts.allowlist,
    totalAllowSats,
    firstRewardCycle,
    bondStartHeight: startBurnHeight,
    unlockCycle,
    windowOpenHeight,
    fee: opts.fee,
    nonce,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Setup bond ${opts.bondIndex} (dry run)`);
      printRows(baseRows);
      printAllowlist(ctx, opts.allowlist);
      printSection('Schedule');
      printRows(scheduleRows);
      if (adminMismatch) {
        printNote(`sender is not the bond admin (${bondAdmin}) — a broadcast would be rejected with ERR_UNAUTHORIZED (u1)`);
      }
      if (tooSoon) {
        printNote(`setup window opens at Bitcoin height ${windowOpenHeight} (in ${windowOpenHeight - bitcoinHeight} blocks); a broadcast now would be rejected with ERR_CANNOT_SETUP_BOND_TOO_SOON (u2)`);
      }
      printNote('re-run with --broadcast to sign with POX5_BOND_ADMIN_PRIVATE_KEY (or POX5_STX_PRIVATE_KEY) and send');
    });
    return;
  }

  if (adminMismatch) {
    throw new CliError(
      `sender ${sender} is not the bond admin ${bondAdmin} — setup-bond is gated on the admin (ERR_UNAUTHORIZED u1). ` +
        'Set POX5_BOND_ADMIN_PRIVATE_KEY to the admin key.',
    );
  }
  if (tooSoon) {
    throw new CliError(
      `bond ${opts.bondIndex} setup window has not opened (ERR_CANNOT_SETUP_BOND_TOO_SOON u2): ` +
        `opens at Bitcoin height ${windowOpenHeight}, current is ${bitcoinHeight}`,
    );
  }

  const signer = new TransactionSigner(tx);
  signer.signOrigin(privateKey);
  const result = (await broadcastTransaction({ transaction: signer.getTxInComplete(), ...ctx.net })) as {
    txid?: string;
    error?: string;
    reason?: string;
  };
  if (result.error) throw new CliError(`broadcast rejected: ${result.reason ?? result.error}`);
  const txid = result.txid!;

  output(ctx, { ...json, txid }, () => {
    printSection(`Setup bond ${opts.bondIndex}`);
    printRows([...baseRows, ['txid', explorerTxLink(ctx.config, txid)]]);
    printAllowlist(ctx, opts.allowlist);
    printSection('Schedule');
    printRows(scheduleRows);
  });
}

function allowlistSummary(allowlist: AllowEntry[], total: bigint): string {
  if (allowlist.length === 0) return 'none';
  return `${allowlist.length} staker${allowlist.length === 1 ? '' : 's'} (${sats(total)})`;
}

function printAllowlist(ctx: Ctx, allowlist: AllowEntry[]): void {
  for (const e of allowlist) {
    process.stdout.write(`  ${dim('•')} ${explorerLink(ctx.config, e.staker)} ${dim('→')} ${sats(e.maxSats)}\n`);
  }
}

function windowStatus(bitcoinHeight: number, open: number, start: number): string {
  if (bitcoinHeight < open) return `opens at ${open} (in ${open - bitcoinHeight} blocks), closes before ${start}`;
  return `open now, closes before ${start} (in ${start - bitcoinHeight} blocks)`;
}

async function fetchBondAdmin(ctx: Ctx): Promise<string | undefined> {
  const boot = ctx.net.network.bootAddress;
  const url = `${ctx.config.stacksApiUrl}/v2/data_var/${boot}/pox-5/bond-admin?proof=0`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const { data } = (await res.json()) as { data?: string };
  if (!data) return undefined;
  try {
    return cvToString(deserializeCV(data));
  } catch {
    return undefined;
  }
}
