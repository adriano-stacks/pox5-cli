{
  description = "pox5-cli — dev shell for the Stacks PoX-5 testnet CLI (latest Node + pnpm)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Everything required to install, typecheck, run, and build the CLI.
          # tsx/typescript themselves are pnpm-managed devDependencies.
          packages = [
            pkgs.nodejs_latest # Node.js (latest current release)
            pkgs.pnpm          # package manager
          ];
          shellHook = ''
            echo "pox5-cli dev shell — node $(node -v), pnpm $(pnpm -v)"
          '';
        };
      });
    };
}
