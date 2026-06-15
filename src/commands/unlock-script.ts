import { buildUnlockScript } from '@stacks/bitcoin-staking';
import { bytesToHex } from '@stacks/common';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { btcNetwork, resolveBtcKey } from '../btc.js';
import { dim, output, printNote, printRows, printSection } from '../output.js';

export function unlockScriptCommand(ctx: Ctx, publicKeyArg?: string): void {
  const fromWif = publicKeyArg === undefined;
  const publicKey = fromWif
    ? resolveBtcKey(btcNetwork('regtest')).publicKey
    : publicKeyArg.replace(/^0x/i, '').toLowerCase();

  if (!/^(02|03)[0-9a-f]{64}$/.test(publicKey)) {
    throw new CliError(
      'expected a 33-byte compressed secp256k1 public key (66 hex chars starting with 02 or 03)',
    );
  }

  const scriptHex = bytesToHex(buildUnlockScript(publicKey));
  const breakdown = [
    { bytes: '21', op: 'OP_PUSHBYTES_33', meaning: 'push the 33-byte public key that follows' },
    { bytes: publicKey, op: 'data', meaning: 'compressed secp256k1 public key' },
    { bytes: 'ac', op: 'OP_CHECKSIG', meaning: 'pop a signature from the witness, verify it against the key, leave true/false' },
  ];

  output(
    ctx,
    { publicKey, publicKeySource: fromWif ? 'POX5_BTC_WIF' : 'argument', scriptHex, breakdown },
    () => {
      printSection('Unlock script');
      printRows([
        ['public key', `${publicKey}${fromWif ? dim(' (derived from POX5_BTC_WIF)') : ''}`],
        ['script hex', scriptHex],
      ]);

      printSection('Byte by byte');
      for (const b of breakdown) {
        process.stdout.write(`  ${b.bytes}  ${dim(`${b.op === 'data' ? '' : `${b.op} — `}${b.meaning}`)}\n`);
      }

      printSection('Where it goes');
      printNote('the fragment is spliced into the bond lock script raw (not push-wrapped) and must leave a boolean on the stack');
      printNote('as --early-unlock-bytes (setup-bond): runs in the early-exit branch after the staker-commitment check, and the lock script\'s shared OP_VERIFY consumes its result — OP_CHECKSIG (ac), never OP_CHECKSIGVERIFY (ad), or the branch can never validate');
      printNote('as the staker unlock bytes: lock-btc and register-for-bond derive exactly this fragment from POX5_BTC_WIF; it runs last in both branches and its result decides the spend');
      printNote('to satisfy it, the spender\'s witness provides a signature by the key\'s owner');
    },
  );
}
