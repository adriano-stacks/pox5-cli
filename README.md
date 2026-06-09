# pox5-cli

A TypeScript CLI for inspecting the Stacks **PoX-5** (Bitcoin Staking) internal
testnet, built on [`@stacks/bitcoin-staking`](https://www.npmjs.com/package/@stacks/bitcoin-staking)
and `@stacks/transactions`.

**Scope:** read-only inspection — network/cycle state, positions, bonds,
ratio quotes, schedules, rewards, signer-manager grants — plus the testnet
faucets, and solo STX staking (`stake`). Remaining write flows (paired BTC,
rewards/admin) come later.

## Requirements

This machine has no Node on `PATH`; the toolchain comes from Nix. Everything
below assumes the latest Node + pnpm provided by Nix (see `flake.nix`).

```bash
# Drop into a dev shell (node + pnpm):
nix develop          # uses ./flake.nix

# …or run one-off commands with the toolchain:
nix shell nixpkgs#nodejs_latest nixpkgs#pnpm --command <cmd>
```

## Setup

```bash
nix shell nixpkgs#nodejs_22 nixpkgs#pnpm --command pnpm install
```

`pnpm install` runs a `postinstall` step (`scripts/fix-esm-marker.mjs`) that
works around an upstream packaging bug — see [Known issues](#known-issues).

## Usage

Either via the launcher (no PATH setup needed):

```bash
./pox5 info
./pox5 position ST1M2NRVJXSBREG78SXPDZJQ3BMAHV34JVD9HXZHF
```

…or inside the dev shell:

```bash
pnpm pox5 info          # = tsx src/index.ts info
pnpm pox5 --json info   # flags pass straight through — no `--` separator
```

…or run the built binary (see [Development](#development)):

```bash
pnpm build && node dist/pox5.cjs info
```

### Commands

| Command | What it shows |
| --- | --- |
| `info` | active pox contract id, PoX activation heights (per-version epoch boundaries), Bitcoin block height, reward cycle, cycle/prepare lengths, prepare-phase flag + blocks/minutes until prepare, distribution cycle, staking minimum |
| `position <stxAddress>` | STX balance/locked/liquid, unlock height, STX-only stake, paired-bond membership |
| `bond <index> [--address <a>]` | bond params (target rate, ratio, early-unlock), sBTC fill, derived schedule, optional allowlist cap |
| `schedule <index>` | phase timeline (announced → open → active → re-lock → closed) in Bitcoin block heights, L1 unlock height |
| `quote --bond <i> (--sats <n> \| --btc <n>)` | required STX for a BTC commitment under the bond's static ratio |
| `rewards <signerManager> (--bond <i> \| --cycle <c>)` | earned/unclaimed sBTC, settled RPT, shares for a leg |
| `totals [--bond <i>] [--cycle <c>]` | protocol-wide sBTC staked; per-bond fill or per-cycle STX |
| `signer <signerManager> [--key <hex>] [--auth-id <n>]` | registered signer key, grant status, SIP-018 grant hash |
| `signers [cycle] [--stakers] [--staker <a>]` | the cycle's signer set — each signer-manager (with the address controlling it, key, delegated STX/weight, shares). Add `--stakers` to also list the stakers delegating to each (discovered from contract events, confirmed on-chain), or `--staker <a>` for only named addresses. Principals render as clickable explorer links in a TTY |
| `stake --signer-manager <c> --amount <stx> --cycles <n> [--start-height <h>] [--fee <ustx>] [--broadcast]` | lock STX through a signer-manager (solo STX staking). Dry-run by default; `--broadcast` signs with `POX5_STX_PRIVATE_KEY` and sends. Reverts in the prepare phase |
| `faucet stx [stxAddress] [--stacking]` | request testnet STX (500 STX; `--stacking` requests `min_amount_ustx`+20%, capped at 1 / 2 days). Defaults to `POX5_STX_ADDRESS` |
| `faucet btc <btcAddress> [--large \| --xlarge]` | request testnet BTC (0.0001 / 0.01 / 0.5) |
| `keygen [--btc-network <name>]` | generate a fresh STX keypair + BTC WIF/address (default `regtest` to match private-1) |

Global flags: `--json` (machine output), and connection overrides
`--api-url`, `--extended-url`, `--bitcoin-url`, `--explorer-url`, `--boot-address`,
`--chain-id`, `--network-base`, `--first-pox5-cycle`.

## Configuration

Defaults target the `private-1.hiro.so` testnet and need no config. To override,
copy `.env.example` to `.env`. Precedence: **CLI flags > env > built-in defaults**.

Key values for `private-1`:

- Stacks RPC: `https://api.private-1.hiro.so` (the SDK hits `/v2/*` at the host root)
- Extended API (faucets): `https://api.private-1.hiro.so/extended`
- Bitcoin (Esplora): `https://mempool.bitcoin.private-1.hiro.so/api`
- pox-5 contract: `ST000000000000000000002AMW42H.pox-5`
- chain id: `256`

### `--first-pox5-cycle`

This node's `/v2/pox` doesn't advertise a `.pox-5` entry in `contract_versions`,
so the SDK's `firstPox5RewardCycle()` returns `undefined` and bond/schedule
derivation can't run. Set `POX5_FIRST_POX5_CYCLE` (or pass `--first-pox5-cycle`)
to the bond program's first reward cycle to enable those commands.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # esbuild bundle -> dist/pox5.cjs (self-contained, plain-node runnable)
pnpm start       # node dist/pox5.cjs
```

`pnpm build` (also run on `prepare`, so `pnpm link --global` works) produces a
single self-contained `dist/pox5.cjs` with a shebang, exposed as the `pox5`
[`bin`](package.json). It runs under plain Node with **no `node_modules`** —
bundling resolves and inlines everything at build time, which also sidesteps the
ESM packaging quirk below (that only affects the tsx-based source path used by
`./pox5` and `pnpm dev`).

The SDK is pinned to `@stacks/bitcoin-staking@7.4.1-pr.1854.3` — the CI build of
the `feat/bitcoin-staking` branch (PR #1854), with every `@stacks/*` peer pinned
to the same version to avoid duplicate instances. To track branch HEAD instead,
clone `stx-labs/stacks.js@feat/bitcoin-staking`, build the monorepo, and link the
packages via `file:`/`link:`.

## Known issues

- **`@stacks/bitcoin-staking` ESM packaging (branch-specific).** The package's
  `exports.import` points at `dist/esm/index.js`, but it ships no `"type": "module"`,
  so Node loads those ESM-syntax files as CommonJS and named exports vanish
  (`SyntaxError: … does not provide an export named …`). `scripts/fix-esm-marker.mjs`
  drops the missing `{ "type": "module" }` marker beside the ESM build on `postinstall`.

  This is **specific to the `feat/bitcoin-staking` package** — it is the only
  package in the monorepo that declares an `exports` map. The sibling packages
  (`@stacks/transactions`, `network`, `common`), on both the branch and `master`,
  have **no `exports` field**, so native ESM `import` falls back to the legacy
  `main` (CJS) build, which `cjs-module-lexer` parses fine. The clean upstream
  fix: either drop the `exports` map to match the siblings, or do dual-package
  ESM properly (a `dist/esm/package.json` `{"type":"module"}` marker — also for
  `dist/esm-mocks` — plus the existing `require` condition).
