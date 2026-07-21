# pox5-cli

A TypeScript CLI for interacting with Stacks' **PoX-5** (Bitcoin Staking).

> [!WARNING]
> This project has not been audited and should not be used in production.
> Consider it a development/debugging tool.

## Requirements

If you are using `nix` and `direnv`, cloning this repository and entering the
directory will set you up with everything you need.

Otherwise, use `pnpm`.

## Usage

If using `direnv`:

```bash
pox5 info
pox5 position ST1M2NRVJXSBREG78SXPDZJQ3BMAHV34JVD9HXZHF
```

With `pnpm`:

```bash
pnpm pox5 info          # = tsx src/index.ts info
pnpm pox5 --json info   # flags pass straight through — no `--` separator
```

Or run the built CLI directly with Nix, no checkout setup needed:

```bash
nix run . -- info
nix run github:adriano-stacks/pox5-cli -- info   # straight from the repo
```

### Commands

Use `pox5 --help` for the command list, and `pox5 <command> --help` for any
command's arguments and flags. Global flags include `--json` (machine-readable
output) and the connection overrides that mirror the
[Configuration](#configuration) environmental vars.

## Configuration

Defaults target the `testnet-pox5.hiro.so` testnet and need no config. To
override, copy `.env.example` to `.env`. CLI flags override env which overrides
built-in defaults.

Key values for `testnet-pox5`:

- Stacks RPC: `https://api.testnet-pox5.hiro.so` (the SDK hits `/v2/*` at the
  host root)
- Extended API (faucets): `https://api.testnet-pox5.hiro.so/extended`
- Bitcoin (Esplora): `https://mempool.testnet-pox5.hiro.so/api`
- pox-5 contract: `ST000000000000000000002AMW42H.pox-5`
- chain id: `2147483653` (`0x80000005`)

## Development

`nix develop` (or `direnv`, via `.envrc`) drops you into a shell with Node,
`pnpm`, and a `pox5` command that runs the CLI straight from `src/` through
`tsx`. Edits are picked up without a rebuild.

Run `pnpm install` once first: both `pox5` and `pnpm pox5` execute the TypeScript
source, which needs `node_modules`.

The Nix build derives every dependency fetch from `pnpm-lock.yaml` itself
(see `nix/import-pnpm-lock.nix`), so lockfile changes are picked up
automatically — there is no Nix-side hash to refresh. CI builds the flake and
smoke-tests the CLI on every push.
