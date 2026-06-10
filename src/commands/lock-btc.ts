import {
  bondPeriodToBurnHeight,
  buildDefaultUnlockScript,
  buildLockingScript,
  computeBondUnlockHeight,
  computeP2wshOutputScript,
  fetchBondAllowance,
  fetchPoxInfo,
  minUstxForSatsAmount,
} from '@stacks/bitcoin-staking';
import { bytesToHex, hexToBytes } from '@stacks/common';
import * as btc from '@scure/btc-signer';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { resolveStxAddress } from '../address.js';
import {
  broadcastBtcTx,
  btcNetwork,
  fetchBtcTxHex,
  parseTxOutput,
  resolveBtcKey,
  type BtcNetworkName,
} from '../btc.js';
import { bitcoinAddressLink, bitcoinTxLink, explorerLink } from '../explorer.js';
import { fetchBondConfig, requirePoxWithBondCycle } from '../pox.js';
import { bitcoinBlocks, output, printNote, printRows, printSection, sats, stx, type Row } from '../output.js';

const DUST_SATS = 546n;

export interface UtxoRef {
  txid: string;
  vout: number;
}

export interface LockBtcOpts {
  bond: number;
  sats?: bigint;
  btc?: number;
  utxos: UtxoRef[];
  btcFee: bigint;
  btcNetwork: BtcNetworkName;
  broadcast: boolean;
}

export async function lockBtcCommand(ctx: Ctx, opts: LockBtcOpts): Promise<void> {
  let satsAmount: bigint;
  if (opts.sats !== undefined) satsAmount = opts.sats;
  else if (opts.btc !== undefined) satsAmount = BigInt(Math.round(opts.btc * 1e8));
  else throw new CliError('provide --sats <n> or --btc <n>');
  if (satsAmount <= DUST_SATS) throw new CliError(`--sats must be above the ${DUST_SATS} sats dust limit`);
  if (opts.utxos.length === 0) throw new CliError('provide at least one --utxo <txid>:<vout> to spend');

  const stxAddress = resolveStxAddress(ctx);
  const net = btcNetwork(opts.btcNetwork);
  const key = resolveBtcKey(net);
  if (ctx.config.btcAddress && ctx.config.btcAddress !== key.address) {
    throw new CliError(
      `POX5_BTC_ADDRESS (${ctx.config.btcAddress}) does not match the address derived from POX5_BTC_WIF (${key.address})`,
    );
  }

  const [bond, poxRaw] = await Promise.all([fetchBondConfig(ctx, opts.bond), fetchPoxInfo(ctx.net)]);
  if (!bond) throw new CliError(`bond ${opts.bond} is not configured on this contract`);
  const pox = requirePoxWithBondCycle(ctx, poxRaw);

  const bitcoinHeight = pox.currentBurnchainBlockHeight;
  const startBurnHeight = bondPeriodToBurnHeight({ bondIndex: opts.bond, poxInfo: pox });
  if (bitcoinHeight >= startBurnHeight) {
    throw new CliError(
      `bond ${opts.bond} already started at Bitcoin block ${startBurnHeight} (current is ${bitcoinHeight}) — ` +
        'locking now would strand the BTC: registration is closed (ERR_BOND_ALREADY_STARTED u43)',
    );
  }

  const allowance = await fetchBondAllowance({ bondIndex: opts.bond, address: stxAddress, ...ctx.net });
  if (allowance < satsAmount) {
    throw new CliError(
      `allowlist cap for ${stxAddress} on bond ${opts.bond} is ${allowance} sats — ` +
        `locking ${satsAmount} sats would be rejected at registration (ERR_TOO_MUCH_SATS u10)`,
    );
  }

  const unlockHeight = computeBondUnlockHeight({ bondIndex: opts.bond, poxInfo: pox });
  const unlockBytes = buildDefaultUnlockScript(key.publicKey);
  const lockingScript = buildLockingScript({
    stxAddress,
    unlockHeight,
    unlockBytes,
    earlyUnlockBytes: bond.earlyUnlockBytes,
  });
  const lockOutputScript = computeP2wshOutputScript(lockingScript);
  const lockAddress = btc.Address(net).encode({ type: 'wsh', hash: lockOutputScript.slice(2) });
  const ownScript = btc.p2wpkh(hexToBytes(key.publicKey), net).script;

  const inputs: { ref: UtxoRef; amount: bigint }[] = [];
  for (const ref of opts.utxos) {
    const txHex = await fetchBtcTxHex(ctx.config, ref.txid);
    const out = parseTxOutput(txHex, ref.vout);
    if (bytesToHex(out.script) !== bytesToHex(ownScript)) {
      throw new CliError(`utxo ${ref.txid}:${ref.vout} does not pay the POX5_BTC_WIF address ${key.address}`);
    }
    inputs.push({ ref, amount: out.amount });
  }

  const totalIn = inputs.reduce((sum, i) => sum + i.amount, 0n);
  if (totalIn < satsAmount + opts.btcFee) {
    throw new CliError(
      `selected utxos hold ${totalIn} sats — need ${satsAmount + opts.btcFee} (${satsAmount} lock + ${opts.btcFee} fee)`,
    );
  }
  const change = totalIn - satsAmount - opts.btcFee;
  const hasChange = change >= DUST_SATS;
  const fee = hasChange ? opts.btcFee : opts.btcFee + change;

  const tx = new btc.Transaction();
  for (const { ref, amount } of inputs) {
    tx.addInput({
      txid: ref.txid,
      index: ref.vout,
      witnessUtxo: { script: ownScript, amount },
    });
  }
  tx.addOutput({ script: lockOutputScript, amount: satsAmount });
  if (hasChange) tx.addOutputAddress(key.address, change, net);
  tx.sign(key.privateKey);
  tx.finalize();
  const txHex = bytesToHex(tx.extract());
  const txid = tx.id;

  const requiredUstx = minUstxForSatsAmount({
    sats: satsAmount,
    stxValueRatio: bond.stxValueRatio,
    minUstxRatioBps: bond.minUstxRatioBps,
  });

  const baseRows: Row[] = [
    ['staker', explorerLink(ctx.config, stxAddress)],
    ['bond', opts.bond],
    ['lock address', bitcoinAddressLink(ctx.config, lockAddress)],
    ['lock amount', sats(satsAmount)],
    ['allowlist cap', sats(allowance)],
    ['paired STX minimum', stx(requiredUstx)],
    ['unlock height', `${unlockHeight} (Bitcoin)`],
    ['register before', `Bitcoin block ${startBurnHeight} (in ${bitcoinBlocks(startBurnHeight - bitcoinHeight)})`],
    ['inputs', inputs.map((i) => `${i.ref.txid}:${i.ref.vout}`).join(', ')],
    ['change', hasChange ? sats(change) : 'none (folded into fee)'],
    ['Bitcoin fee', `${fee} sats`],
    ['txid', txid],
  ];

  const json = {
    staker: stxAddress,
    bondIndex: opts.bond,
    lockAddress,
    lockSats: satsAmount,
    allowanceSats: allowance,
    requiredUstx,
    unlockHeight,
    bondStartHeight: startBurnHeight,
    unlockBytes: bytesToHex(unlockBytes),
    lockingScript: bytesToHex(lockingScript),
    inputs: inputs.map((i) => ({ ...i.ref, sats: i.amount })),
    changeSats: hasChange ? change : 0n,
    feeSats: fee,
    txid,
    txHex,
  };

  if (!opts.broadcast) {
    output(ctx, { mode: 'dry-run', ...json }, () => {
      printSection(`Lock BTC for bond ${opts.bond} (dry run)`);
      printRows(baseRows);
      printNote('the BTC stays locked until the unlock height even if registration never happens');
      printNote('re-run with --broadcast to sign with POX5_BTC_WIF and send');
    });
    return;
  }

  const sentTxid = await broadcastBtcTx(ctx.config, txHex);

  output(ctx, { ...json, txid: sentTxid }, () => {
    printSection(`Lock BTC for bond ${opts.bond}`);
    printRows([...baseRows.slice(0, -1), ['txid', bitcoinTxLink(ctx.config, sentTxid)]]);
    printNote(`once confirmed, register with: pox5 register-for-bond --bond ${opts.bond} --btc-txid ${sentTxid}`);
  });
}
