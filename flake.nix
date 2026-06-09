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
          pnpm = pnpmFor pkgs;
        in
        rec {
          default = pox5-cli;

          pox5-cli = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "pox5-cli";
            version = "0.1.0";
            src = ./.;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version;
              inherit pnpm;
              fetcherVersion = 3;
              src = pkgs.lib.fileset.toSource {
                root = ./.;
                fileset = pkgs.lib.fileset.unions [
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  ./.npmrc
                ];
              };
              hash = "sha256-dqplRgQO/CSMeO/BvTTNko9cGhmVP6nwwb0iozeoTRM=";
            };

            nativeBuildInputs = [
              pkgs.nodejs_latest
              pnpm
              pkgs.pnpmConfigHook
              pkgs.makeWrapper
            ];

            buildPhase = ''
              runHook preBuild
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
              description = "CLI for the Stacks PoX-5 (Bitcoin Staking) internal testnet";
              mainProgram = "pox5";
              platforms = systems;
            };
          });
        }
      );

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
