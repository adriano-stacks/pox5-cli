{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Latest pnpm bundles its own Node 24, whose worker-thread teardown trips a
      # macOS EXC_GUARD (close on a guarded fd) and SIGKILLs mid-install. Run it on
      # the latest Node instead, which doesn't hit the bug.
      pnpmFor = pkgs: pkgs.pnpm.override { nodejs-slim = pkgs.nodejs_latest; };
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          importPnpmLock = import ./nix/import-pnpm-lock.nix {
            inherit pkgs;
            inherit (pkgs) lib;
          };

          # node_modules derived entirely from pnpm-lock.yaml: each tarball is
          # fetched against the lockfile's own integrity hash, so there is no
          # extra Nix-side hash to refresh when dependencies change.
          nodeModules = importPnpmLock { lockfile = ./pnpm-lock.yaml; };
        in
        rec {
          default = pox5-cli;

          pox5-cli = pkgs.stdenv.mkDerivation {
            pname = "pox5-cli";
            version = "0.1.0";
            src = ./.;

            nativeBuildInputs = [
              pkgs.nodejs_latest
              pkgs.makeWrapper
            ];

            buildPhase = ''
              runHook preBuild
              ln -s ${nodeModules} node_modules
              node scripts/build.mjs
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/libexec/pox5-cli
              cp dist/pox5.cjs $out/libexec/pox5-cli/pox5.cjs
              makeWrapper ${pkgs.nodejs_latest}/bin/node $out/bin/pox5 \
                --add-flags $out/libexec/pox5-cli/pox5.cjs
              runHook postInstall
            '';

            meta = {
              description = "CLI for Stacks PoX-5 (Bitcoin Staking)";
              mainProgram = "pox5";
              platforms = systems;
            };
          };
        }
      );

      # `nix flake check` builds the package, so lockfile/build breakage is
      # caught by CI.
      checks = forAllSystems (pkgs: {
        build = self.packages.${pkgs.stdenv.hostPlatform.system}.pox5-cli;
      });

      apps = forAllSystems (pkgs: rec {
        default = pox5;
        pox5 = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/pox5";
          meta.description = "Run the pox5 CLI";
        };
      });

      devShells = forAllSystems (
        pkgs:
        let
          pnpm = pnpmFor pkgs;
          # Run the CLI straight from TypeScript source (tsx), so edits are picked
          # up without a rebuild — the dev counterpart to the built `pox5` binary.
          pox5 = pkgs.writeShellScriptBin "pox5" ''exec ${pnpm}/bin/pnpm --silent pox5 "$@"'';
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_latest
              pnpm
              pox5
            ];
            shellHook = ''
              echo "pox5-cli dev shell — node $(node -v), pnpm $(pnpm -v)"
            '';
          };
        }
      );
    };
}
