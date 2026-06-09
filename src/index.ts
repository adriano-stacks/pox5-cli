#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { buildContext, type GlobalOpts } from './context.js';
import { CliError } from './errors.js';
import { dim } from './output.js';
import { infoCommand } from './commands/info.js';
import { positionCommand } from './commands/position.js';
import { bondCommand } from './commands/bond.js';
import { scheduleCommand } from './commands/schedule.js';
import { quoteCommand } from './commands/quote.js';
import { rewardsCommand } from './commands/rewards.js';
import { totalsCommand } from './commands/totals.js';
import { signerCommand } from './commands/signer.js';
import { signersCommand } from './commands/signers.js';
import { faucetBtcCommand, faucetStxCommand } from './commands/faucet.js';
import { keygenCommand, BTC_NETWORK_NAMES, type BtcNetworkName } from './commands/keygen.js';

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

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

const program = new Command();

program
  .name('pox5')
  .description('CLI for the Stacks PoX-5 (Bitcoin Staking) internal testnet — read-only')
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
  .description('PoX-5 contract + burn-chain state (cycle, lengths, prepare phase)')
  .action(async (_o, cmd) => infoCommand(ctxOf(cmd)));

program
  .command('position')
  .description('a Stacks address’s STX balance/lock, STX-only stake, and paired bond')
  .argument('<stxAddress>', 'Stacks principal')
  .action(async (address, _o, cmd) => positionCommand(ctxOf(cmd), address));

program
  .command('bond')
  .description('a bond’s parameters, fill, and (if derivable) schedule')
  .argument('<index>', 'bond index', intArg('index'))
  .option('--address <addr>', 'also show this principal’s allowlist cap for the bond')
  .action(async (index, o, cmd) => bondCommand(ctxOf(cmd), index, { address: o.address }));

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
  .description('earned/unclaimed sBTC for a signer-manager on a bond or STX cycle leg')
  .argument('<signerManager>', 'signer-manager principal')
  .option('--bond <index>', 'bond leg', intArg('--bond'))
  .option('--cycle <cycle>', 'STX-only reward cycle leg', intArg('--cycle'))
  .action(async (signer, o, cmd) => rewardsCommand(ctxOf(cmd), signer, { bond: o.bond, cycle: o.cycle }));

program
  .command('totals')
  .description('protocol-wide totals (sBTC staked; per-bond fill or per-cycle STX)')
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

const collectList = (v: string, acc: string[] = []): string[] => {
  for (const item of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!acc.includes(item)) acc.push(item);
  }
  return acc;
};

program
  .command('signers')
  .description('a cycle’s signer set, the stakers delegating to each, and who controls each signer')
  .argument('[cycle]', 'reward cycle (default: current)', intArg('cycle'))
  .option(
    '--staker <addr>',
    'resolve only these stakers (repeatable, comma-separated) instead of discovering all',
    collectList,
  )
  .option('--no-stakers', 'skip staker enumeration; show the signer set only')
  .action(async (cycle, o, cmd) =>
    signersCommand(ctxOf(cmd), cycle, { staker: o.staker ?? [], stakers: o.stakers !== false }),
  );

const faucet = program.command('faucet').description('request testnet funds from the Hiro faucets');
faucet
  .command('stx')
  .description('request testnet STX')
  .argument('<stxAddress>', 'Stacks principal')
  .action(async (address, _o, cmd) => faucetStxCommand(ctxOf(cmd), address));
faucet
  .command('btc')
  .description('request testnet BTC (default 0.0001; --large 0.01; --xlarge 0.5)')
  .argument('<btcAddress>', 'Bitcoin address')
  .option('--large', '0.01 BTC')
  .option('--xlarge', '0.5 BTC')
  .action(async (address, o, cmd) => faucetBtcCommand(ctxOf(cmd), address, { large: o.large, xlarge: o.xlarge }));

program
  .command('keygen')
  .description('generate a fresh STX keypair and a BTC keypair (WIF + address)')
  .option('--btc-network <name>', `BTC address network: ${BTC_NETWORK_NAMES.join(' | ')}`, 'regtest')
  .action((o, cmd) => keygenCommand(ctxOf(cmd), { btcNetwork: o.btcNetwork as BtcNetworkName }));

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
