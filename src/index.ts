#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { buildContext, type GlobalOpts } from './context.js';
import { CliError } from './errors.js';
import { installFetchRetry } from './fetch-retry.js';
import { dim } from './output.js';
import { infoCommand } from './commands/info.js';
import { positionCommand } from './commands/position.js';
import { bondCommand } from './commands/bond.js';
import { bondsCommand } from './commands/bonds.js';
import { scheduleCommand } from './commands/schedule.js';
import { quoteCommand } from './commands/quote.js';
import { rewardsCommand } from './commands/rewards.js';
import { calculateRewardsCommand } from './commands/calculate-rewards.js';
import { claimRewardsCommand } from './commands/claim-rewards.js';
import { claimStakerRewardsCommand } from './commands/claim-staker-rewards.js';
import { totalsCommand } from './commands/totals.js';
import { signerCommand } from './commands/signer.js';
import { signersCommand } from './commands/signers.js';
import { stakeCommand } from './commands/stake.js';
import { setupBondCommand, type AllowEntry } from './commands/setup-bond.js';
import { setupSignerCommand } from './commands/setup-signer.js';
import { lockBtcCommand, type UtxoRef } from './commands/lock-btc.js';
import { registerForBondCommand } from './commands/register-for-bond.js';
import { stakeSbtcCommand } from './commands/stake-sbtc.js';
import { unstakeSbtcCommand } from './commands/unstake-sbtc.js';
import { earlyExitCommand } from './commands/early-exit.js';
import { unlockScriptCommand } from './commands/unlock-script.js';
import { faucetBtcCommand, faucetSbtcCommand, faucetStxCommand } from './commands/faucet.js';
import { keygenCommand, BTC_NETWORK_NAMES, type BtcNetworkName } from './commands/keygen.js';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

installFetchRetry();

const intArg = (name: string) => (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError(`${name} must be a non-negative integer (got "${v}")`);
  return n;
};
const bigIntArg = (name: string) => (v: string): bigint => {
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new CliError(`${name} must be an integer (got "${v}")`);
  }
  if (n < 0n) throw new CliError(`${name} must be non-negative (got "${v}")`);
  return n;
};
const floatArg = (name: string) => (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${name} must be a positive number (got "${v}")`);
  return n;
};
const stxArg = (name: string) => (v: string): bigint => {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new CliError(`${name} must be STX with up to 6 decimals (got "${v}")`);
  const [whole = '0', frac = ''] = v.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
};
const hexArg = (name: string, maxBytes?: number) => (v: string): string => {
  const h = /^0x/i.test(v) ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) {
    throw new CliError(`${name} must be hex-encoded bytes (got "${v}")`);
  }
  if (maxBytes !== undefined && h.length / 2 > maxBytes) {
    throw new CliError(`${name} must be at most ${maxBytes} bytes (got ${h.length / 2})`);
  }
  return h;
};
const collectAllow = (v: string, acc: AllowEntry[] = []): AllowEntry[] => {
  for (const item of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = item.indexOf(':');
    if (sep < 0) throw new CliError(`--allow must be <staker>:<maxSats> (got "${item}")`);
    const staker = item.slice(0, sep).trim();
    const satsStr = item.slice(sep + 1).trim();
    if (!staker) throw new CliError(`--allow staker is empty (got "${item}")`);
    let maxSats: bigint;
    try {
      maxSats = BigInt(satsStr);
    } catch {
      throw new CliError(`--allow maxSats must be an integer (got "${satsStr}")`);
    }
    if (maxSats < 0n) throw new CliError(`--allow maxSats must be non-negative (got "${satsStr}")`);
    acc.push({ staker, maxSats });
  }
  return acc;
};
const collectList = (v: string, acc: string[] = []): string[] => {
  for (const item of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!acc.includes(item)) acc.push(item);
  }
  return acc;
};
const collectInts = (name: string) => (v: string, acc: number[] = []): number[] => {
  for (const item of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0) throw new CliError(`${name} must be non-negative integers (got "${item}")`);
    acc.push(n);
  }
  return acc;
};

const program = new Command();

program
  .name('pox5')
  .description('CLI for the Stacks PoX-5 (Bitcoin Staking) internal testnet')
  .version('0.1.0')
  .option('--json', 'output machine-readable JSON')
  .option('--api-url <url>', 'Stacks core-node RPC base URL')
  .option('--extended-url <url>', 'Hiro Extended API base URL (faucets)')
  .option('--bitcoin-url <url>', 'Esplora-compatible Bitcoin API base URL')
  .option('--explorer-url <url>', 'Stacks explorer base URL for clickable links')
  .option('--boot-address <addr>', 'pox-5 boot-contract deploy address')
  .option('--chain-id <id>', 'Stacks chain id', intArg('--chain-id'))
  .option('--network-base <name>', 'address/tx-version base: testnet | mainnet | devnet')
  .option('--first-pox5-cycle <n>', 'override the first PoX-5 reward cycle', intArg('--first-pox5-cycle'));

function ctxOf(cmd: Command) {
  return buildContext(cmd.optsWithGlobals() as GlobalOpts);
}

program
  .command('info')
  .description('network, burn-chain, and reward-cycle state')
  .action(async (_o, cmd) => infoCommand(ctxOf(cmd)));

program
  .command('position')
  .description('a Stacks address’s STX balance/lock, STX-only stake, and paired bond (default: POX5_STX_ADDRESS)')
  .argument('[stxAddress]', 'Stacks principal (default: POX5_STX_ADDRESS)')
  .action(async (address, _o, cmd) => positionCommand(ctxOf(cmd), address));

program
  .command('bonds')
  .description('list every bond set up on the contract (discovered from contract events)')
  .action(async (_o, cmd) => bondsCommand(ctxOf(cmd)));

program
  .command('bond')
  .description('a bond’s parameters, fill, and (if derivable) schedule')
  .argument('<index>', 'bond index', intArg('index'))
  .option('--address <addr>', 'show allocation + filled for these principals (repeatable, comma-separated; default: POX5_STX_ADDRESS)', collectList)
  .option('--allowlist', 'list the full allowlist + capacity (queries contract events)')
  .action(async (index, o, cmd) => bondCommand(ctxOf(cmd), index, { addresses: o.address ?? [], allowlist: o.allowlist === true }));

program
  .command('schedule')
  .description('phase timeline (announced/open/active/re-lock/closed) for a bond')
  .argument('<index>', 'bond index', intArg('index'))
  .action(async (index, _o, cmd) => scheduleCommand(ctxOf(cmd), index));

program
  .command('quote')
  .description('required STX for a BTC commitment under a bond’s static ratio')
  .requiredOption('--bond <index>', 'bond index', intArg('--bond'))
  .option('--sats <n>', 'BTC commitment in sats', bigIntArg('--sats'))
  .option('--btc <n>', 'BTC commitment in BTC', floatArg('--btc'))
  .action(async (o, cmd) => quoteCommand(ctxOf(cmd), { bond: o.bond, sats: o.sats, btc: o.btc }));

program
  .command('rewards')
  .description('all claimed, claimable, and gathered-but-unsettled (pending) sBTC for a signer-manager, every cycle and leg, most recent first')
  .argument('[signerManager]', 'signer-manager principal (default: <POX5_STX_ADDRESS>.signer-manager)')
  .option('--cycle <cycle>', 'restrict to a single reward cycle (default: every cycle)', intArg('--cycle'))
  .option('--bond <index>', 'restrict to a single bond leg (default: the STX-only leg + every bond)', intArg('--bond'))
  .action(async (signer, o, cmd) => rewardsCommand(ctxOf(cmd), signer, { cycle: o.cycle, bond: o.bond }));

program
  .command('calculate-rewards')
  .description('settle a distribution cycle: run the sBTC reward waterfall over the active bonds; dry run unless --broadcast')
  .option('--bond <index>', 'override the bond list (default: auto-detect the bonds active at the calculation height, in canonical order; repeatable, comma-separated)', collectInts('--bond'))
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    calculateRewardsCommand(ctxOf(cmd), {
      bonds: o.bond ?? [],
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('claim-rewards')
  .description('pull a signer-manager’s settled sBTC out of the contract (routes through the manager); dry run unless --broadcast')
  .requiredOption('--cycle <cycle>', 'reward cycle to claim (the just-settled cycle = current distribution cycle − 1)', intArg('--cycle'))
  .option('--bond <index>', 'a bond leg to claim (repeatable, comma-separated)', collectInts('--bond'))
  .option('--signer-manager <principal>', 'signer-manager to claim for (default: <sender>.signer-manager)')
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    claimRewardsCommand(ctxOf(cmd), {
      signerManager: o.signerManager,
      cycle: o.cycle,
      bonds: o.bond ?? [],
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('claim-staker-rewards')
  .description('pay an individual staker their share out of a signer-manager (routes through the manager); dry run unless --broadcast')
  .requiredOption('--cycle <cycle>', 'reward cycle to claim', intArg('--cycle'))
  .option('--bond <index>', 'the bond leg to claim (omit for the STX-only leg)', intArg('--bond'))
  .option('--staker <principal>', 'the staker to pay (default: POX5_STX_ADDRESS)')
  .option('--signer-manager <principal>', 'signer-manager the staker delegates through (default: <sender>.signer-manager)')
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    claimStakerRewardsCommand(ctxOf(cmd), {
      staker: o.staker,
      signerManager: o.signerManager,
      cycle: o.cycle,
      bond: o.bond,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('totals')
  .description('protocol-wide totals (sBTC staked, reserve fund; per-bond fill or per-cycle STX)')
  .option('--bond <index>', 'include this bond’s fill + shares', intArg('--bond'))
  .option('--cycle <cycle>', 'include this cycle’s STX stacked + shares', intArg('--cycle'))
  .action(async (o, cmd) => totalsCommand(ctxOf(cmd), { bond: o.bond, cycle: o.cycle }));

program
  .command('signer')
  .description('a signer-manager’s registered signer key and grant status')
  .argument('<signerManager>', 'signer-manager principal')
  .option('--key <hex>', 'check whether this signer key has an active grant')
  .option('--auth-id <n>', 'compute the SIP-018 grant message hash for this auth id', intArg('--auth-id'))
  .action(async (signer, o, cmd) => signerCommand(ctxOf(cmd), signer, { key: o.key, authId: o.authId }));

program
  .command('signers')
  .description('a cycle’s signer set and who controls each signer (add --stakers to also list delegating stakers)')
  .argument('[cycle]', 'reward cycle (default: current)', intArg('cycle'))
  .option('--stakers', 'also list the stakers delegating to each signer (queries contract events)')
  .option(
    '--staker <addr>',
    'list only these stakers (repeatable, comma-separated); implies --stakers for the named addresses',
    collectList,
  )
  .action(async (cycle, o, cmd) =>
    signersCommand(ctxOf(cmd), cycle, { staker: o.staker ?? [], stakers: o.stakers === true }),
  );

program
  .command('stake')
  .description('lock STX through a signer-manager (solo STX staking); dry run unless --broadcast')
  .requiredOption('--signer-manager <principal>', 'signer-manager contract to route through')
  .requiredOption('--amount <stx>', 'STX to lock (e.g. 60000)', stxArg('--amount'))
  .requiredOption('--cycles <n>', 'number of reward cycles to lock for', intArg('--cycles'))
  .option('--start-height <h>', 'first Bitcoin block height (default: current)', intArg('--start-height'))
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    stakeCommand(ctxOf(cmd), {
      signerManager: o.signerManager,
      amountUstx: o.amount,
      cycles: o.cycles,
      startHeight: o.startHeight,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('setup-bond')
  .description('issue a protocol bond (bond-admin only); dry run unless --broadcast')
  .argument('<index>', 'bond index to set up', intArg('index'))
  .requiredOption('--target-rate <bps>', 'target yield APY in basis points', intArg('--target-rate'))
  .requiredOption('--stx-ratio <n>', 'STX:BTC value ratio (uSTX per 100 sats)', bigIntArg('--stx-ratio'))
  .requiredOption('--min-ratio <bps>', 'minimum STX collateral ratio in basis points', intArg('--min-ratio'))
  .option('--early-unlock-bytes <hex>', 'Bitcoin early-exit script bytes (default: the bond-admin key’s OP_CHECKSIG unlock fragment, per unlock-script)', hexArg('--early-unlock-bytes', 683))
  .option('--allow <staker:maxSats>', 'allowlist a staker and its max sats (repeatable, comma-separated)', collectAllow)
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (index, o, cmd) =>
    setupBondCommand(ctxOf(cmd), {
      bondIndex: index,
      targetRateBps: o.targetRate,
      stxValueRatio: o.stxRatio,
      minUstxRatioBps: o.minRatio,
      earlyUnlockBytesHex: o.earlyUnlockBytes,
      allowlist: o.allow ?? [],
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

const collectUtxos = (v: string, acc: UtxoRef[] = []): UtxoRef[] => {
  for (const item of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = item.lastIndexOf(':');
    if (sep < 0) throw new CliError(`--utxo must be <txid>:<vout> (got "${item}")`);
    const txid = item.slice(0, sep).trim().replace(/^0x/, '');
    const voutStr = item.slice(sep + 1).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new CliError(`--utxo txid must be 32 hex bytes (got "${txid}")`);
    const vout = Number(voutStr);
    if (!Number.isInteger(vout) || vout < 0) throw new CliError(`--utxo vout must be a non-negative integer (got "${voutStr}")`);
    acc.push({ txid: txid.toLowerCase(), vout });
  }
  return acc;
};

program
  .command('setup-signer')
  .description('deploy and register a minimal signer-manager contract under the sender; dry run unless --broadcast')
  .option('--name <contractName>', 'contract name to deploy under the sender', 'signer-manager')
  .option('--auth-id <n>', 'signer-key grant auth id (default: 1)', intArg('--auth-id'))
  .option('--deploy-fee <ustx>', 'deploy transaction fee in microSTX (default: 100000)', bigIntArg('--deploy-fee'))
  .option('--fee <ustx>', 'register transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    setupSignerCommand(ctxOf(cmd), {
      name: o.name,
      authId: o.authId ?? 1,
      deployFee: o.deployFee ?? 100000n,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('unlock-script')
  .description('build and explain the <pubkey> OP_CHECKSIG unlock fragment (staker unlock or early-unlock bytes)')
  .argument('[btcPublicKey]', '33-byte compressed public key (default: derived from POX5_BTC_WIF)')
  .action((publicKey, _o, cmd) => unlockScriptCommand(ctxOf(cmd), publicKey));

program
  .command('lock-btc')
  .description('fund a bond’s Bitcoin timelock from POX5_BTC_WIF; dry run unless --broadcast')
  .requiredOption('--bond <index>', 'bond index to lock for', intArg('--bond'))
  .option('--sats <n>', 'BTC commitment in sats', bigIntArg('--sats'))
  .option('--btc <n>', 'BTC commitment in BTC', floatArg('--btc'))
  .requiredOption('--utxo <txid:vout>', 'UTXO to spend (repeatable, comma-separated)', collectUtxos)
  .option('--btc-fee <sats>', 'Bitcoin transaction fee in sats (default: 1000)', bigIntArg('--btc-fee'))
  .option('--btc-network <name>', `BTC address network: ${BTC_NETWORK_NAMES.join(' | ')}`, 'regtest')
  .option('--broadcast', 'sign with POX5_BTC_WIF and broadcast to Bitcoin (default: dry run)')
  .action(async (o, cmd) =>
    lockBtcCommand(ctxOf(cmd), {
      bond: o.bond,
      sats: o.sats,
      btc: o.btc,
      utxos: o.utxo,
      btcFee: o.btcFee ?? 1000n,
      btcNetwork: o.btcNetwork as BtcNetworkName,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('register-for-bond')
  .description('register a confirmed Bitcoin lock for a bond with an SPV proof (paired BTC); dry run unless --broadcast')
  .requiredOption('--bond <index>', 'bond index to register for', intArg('--bond'))
  .requiredOption('--btc-txid <txid>', 'Bitcoin transaction that funded the lock (see lock-btc)')
  .option('--signer-manager <principal>', 'signer-manager to route through (default: <sender>.signer-manager)')
  .option('--amount <stx>', 'paired STX to lock (default: the bond minimum for the locked sats)', stxArg('--amount'))
  .option('--btc-network <name>', `BTC address network: ${BTC_NETWORK_NAMES.join(' | ')}`, 'regtest')
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) =>
    registerForBondCommand(ctxOf(cmd), {
      bond: o.bond,
      btcTxid: (o.btcTxid as string).replace(/^0x/, '').toLowerCase(),
      signerManager: o.signerManager,
      amountUstx: o.amount,
      btcNetwork: o.btcNetwork as BtcNetworkName,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('stake-sbtc')
  .description('stake sBTC into a bond (no L1 lock — the contract custodies the sBTC); dry run unless --broadcast')
  .requiredOption('--bond <index>', 'bond index to stake into', intArg('--bond'))
  .option('--sats <n>', 'sBTC to stake in base units (sats)', bigIntArg('--sats'))
  .option('--sbtc <n>', 'sBTC to stake in whole sBTC', floatArg('--sbtc'))
  .option('--signer-manager <principal>', 'signer-manager to route through (default: <sender>.signer-manager)')
  .option('--amount <stx>', 'paired STX to lock (default: the bond minimum for the staked sats)', stxArg('--amount'))
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) => {
    let amountSats: bigint;
    if (o.sats !== undefined) amountSats = o.sats;
    else if (o.sbtc !== undefined) amountSats = BigInt(Math.round(o.sbtc * 1e8));
    else throw new CliError('specify the sBTC amount with --sats or --sbtc');
    return stakeSbtcCommand(ctxOf(cmd), {
      bond: o.bond,
      amountSats,
      signerManager: o.signerManager,
      amountUstx: o.amount,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    });
  });

program
  .command('unstake-sbtc')
  .description('withdraw some or all staked sBTC from your active bond (sBTC stakes only); dry run unless --broadcast')
  .option('--sats <n>', 'sBTC to withdraw in base units (sats)', bigIntArg('--sats'))
  .option('--sbtc <n>', 'sBTC to withdraw in whole sBTC', floatArg('--sbtc'))
  .option('--signer-manager <principal>', 'signer-manager to route through (default: the membership signer)')
  .option('--fee <ustx>', 'transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with POX5_STX_PRIVATE_KEY and broadcast (default: dry run)')
  .action(async (o, cmd) => {
    let amountSats: bigint;
    if (o.sats !== undefined) amountSats = o.sats;
    else if (o.sbtc !== undefined) amountSats = BigInt(Math.round(o.sbtc * 1e8));
    else throw new CliError('specify the sBTC amount with --sats or --sbtc');
    return unstakeSbtcCommand(ctxOf(cmd), {
      amountSats,
      signerManager: o.signerManager,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    });
  });

const utxoArg = (name: string) => (v: string): UtxoRef => {
  const refs = collectUtxos(v);
  if (refs.length !== 1) throw new CliError(`${name} must be a single <txid>:<vout> (got ${refs.length})`);
  return refs[0]!;
};

program
  .command('early-exit')
  .description('exit a bond early: spend the L1 timelock via its early-exit branch and announce it on L2; dry run unless --broadcast')
  .requiredOption('--bond <index>', 'bond index to exit', intArg('--bond'))
  .option('--utxo <txid:vout>', 'the lock-btc output to spend on Bitcoin (omit to only announce on L2)', utxoArg('--utxo'))
  .option('--to <btcAddress>', 'where to send the recovered BTC (default: POX5_BTC_WIF address)')
  .option('--btc-fee <sats>', 'Bitcoin transaction fee in sats (default: 1000)', bigIntArg('--btc-fee'))
  .option('--btc-network <name>', `BTC address network: ${BTC_NETWORK_NAMES.join(' | ')}`, 'regtest')
  .option('--signer-manager <principal>', 'old signer-manager for the announce (default: the membership signer)')
  .option('--fee <ustx>', 'announce transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--no-announce', 'skip the L2 announce-l1-early-exit (only spend the L1 lock)')
  .option('--broadcast', 'broadcast the Bitcoin spend and/or sign the announce with POX5_STX_PRIVATE_KEY (default: dry run)')
  .action(async (o, cmd) =>
    earlyExitCommand(ctxOf(cmd), {
      bond: o.bond,
      utxo: o.utxo,
      to: o.to,
      btcFee: o.btcFee ?? 1000n,
      btcNetwork: o.btcNetwork as BtcNetworkName,
      signerManager: o.signerManager,
      fee: o.fee ?? 10000n,
      announce: o.announce !== false,
      broadcast: o.broadcast === true,
    }),
  );

const faucet = program.command('faucet').description('request testnet funds from the faucets');
faucet
  .command('stx')
  .description('request testnet STX (default: POX5_STX_ADDRESS)')
  .argument('[stxAddress]', 'Stacks principal (default: POX5_STX_ADDRESS)')
  .option('--stacking', 'request the larger stacking amount (min_amount_ustx + 20%; rate-limited to 1 / 2 days)')
  .action(async (address, o, cmd) => faucetStxCommand(ctxOf(cmd), address, { stacking: o.stacking }));
faucet
  .command('btc')
  .description('request testnet BTC (default 0.0001; --large 0.01; --xlarge 0.5)')
  .argument('[btcAddress]', 'Bitcoin address (default: POX5_BTC_ADDRESS)')
  .option('--large', '0.01 BTC')
  .option('--xlarge', '0.5 BTC')
  .action(async (address, o, cmd) => faucetBtcCommand(ctxOf(cmd), address, { large: o.large, xlarge: o.xlarge }));
faucet
  .command('sbtc')
  .description('mint sBTC via the deployer-owned sbtc-deposit minter (default: 1 sBTC); dry run unless --broadcast')
  .argument('[stxAddress]', 'recipient principal (default: POX5_STX_ADDRESS)')
  .option('--sbtc <n>', 'amount in sBTC (default: 1)', floatArg('--sbtc'))
  .option('--sats <n>', 'amount in base units (overrides --sbtc)', bigIntArg('--sats'))
  .option('--deploy-fee <ustx>', 'minter deploy fee in microSTX (default: 100000)', bigIntArg('--deploy-fee'))
  .option('--fee <ustx>', 'mint transaction fee in microSTX (default: 10000)', bigIntArg('--fee'))
  .option('--broadcast', 'sign with the sBTC deployer key and broadcast (default: dry run)')
  .action(async (address, o, cmd) =>
    faucetSbtcCommand(ctxOf(cmd), address, {
      sats: o.sats,
      sbtc: o.sbtc,
      deployFee: o.deployFee ?? 100000n,
      fee: o.fee ?? 10000n,
      broadcast: o.broadcast === true,
    }),
  );

program
  .command('keygen')
  .description('generate a fresh STX keypair and a BTC keypair (add --env to print .env format)')
  .option('--btc-network <name>', `BTC address network: ${BTC_NETWORK_NAMES.join(' | ')}`, 'regtest')
  .option('--env', 'print POX5_* lines for redirecting into .env')
  .action((o, cmd) => keygenCommand(ctxOf(cmd), { btcNetwork: o.btcNetwork as BtcNetworkName, env: o.env }));

async function main() {
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.message}\n`);
  } else {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    if (process.env.POX5_DEBUG) process.stderr.write(dim(String((err as Error).stack)) + '\n');
  }
  process.exit(1);
});
