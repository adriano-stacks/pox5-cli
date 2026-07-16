# importPnpmLock: build a pnpm-style node_modules directly from pnpm-lock.yaml.
#
# Every tarball is fetched as its own fixed-output derivation whose hash is the
# lockfile's own `integrity` field (SRI, which Nix accepts verbatim), so there
# is no manual aggregate hash to refresh when the lockfile changes — the Nix
# build follows pnpm-lock.yaml automatically. This also sidesteps pnpm 11's
# lossy package store (platform-specific optional dependencies never make it
# into the store that nixpkgs' fetchPnpmDeps captures).
#
# Platform-specific optional dependencies (cpu/os/libc fields) are filtered per
# host platform at eval time, like pnpm does at install time.
#
# Note: the YAML → JSON conversion is import-from-derivation, so evaluation
# builds one tiny derivation before anything else.
#
# Supported lockfile subset (asserted below): lockfileVersion 9.x, a single "."
# importer, registry tarballs with integrity hashes. Not handled: peer-suffixed
# snapshot keys ("pkg@1.0.0(peer@2)"), git/tarball/link dependencies, patches,
# and multi-package workspaces.
{ pkgs, lib }:

{
  # Path to pnpm-lock.yaml
  lockfile,
}:

let
  lock = builtins.fromJSON (
    builtins.readFile (
      pkgs.runCommand "pnpm-lock.json" { nativeBuildInputs = [ pkgs.yq-go ]; } ''
        yq -o=json . ${lockfile} > $out
      ''
    )
  );

  node = pkgs.stdenv.hostPlatform.node; # { arch = "arm64"; platform = "linux"; ... }

  # pnpm skips optional deps whose cpu/os/libc don't match the host.
  supported =
    pkg:
    (!(pkg ? cpu) || builtins.elem node.arch pkg.cpu)
    && (!(pkg ? os) || builtins.elem node.platform pkg.os)
    && (!(pkg ? libc) || builtins.elem (if pkgs.stdenv.hostPlatform.isMusl then "musl" else "glibc") pkg.libc);

  # "name@version" -> { name, version }; names may be scoped ("@scope/pkg").
  parseKey =
    key:
    let
      m = builtins.match "(@?[^@]+)@(.+)" key;
    in
    assert lib.assertMsg (m != null) "importPnpmLock: cannot parse package key '${key}'";
    {
      name = builtins.elemAt m 0;
      version = builtins.elemAt m 1;
    };

  packages = lib.filterAttrs (_: supported) lock.packages;

  tarballs = lib.mapAttrs (
    key: pkg:
    let
      inherit (parseKey key) name version;
    in
    assert lib.assertMsg (pkg.resolution ? integrity && !(pkg.resolution ? tarball))
      "importPnpmLock: package '${key}' does not resolve to a plain registry tarball";
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/${name}/-/${baseNameOf name}-${version}.tgz";
      hash = pkg.resolution.integrity;
    }
  ) packages;

  # pnpm's directory naming inside .pnpm: "/" becomes "+".
  sanitize = key: lib.replaceStrings [ "/" ] [ "+" ] key;

  # Dependency edges of a snapshot, keeping only packages that exist for this
  # platform (dropped optionals are simply absent, matching pnpm's semantics).
  edgesOf =
    snap:
    lib.filterAttrs (name: version: tarballs ? "${name}@${version}") (
      (snap.dependencies or { }) // (snap.optionalDependencies or { })
    );

  rootImporter = lock.importers.".";
  rootDeps = lib.mapAttrs (_: spec: spec.version) (
    (rootImporter.dependencies or { }) // (rootImporter.devDependencies or { })
  );

  unpackCommands = lib.concatStrings (
    lib.mapAttrsToList (
      key: _:
      let
        inherit (parseKey key) name;
        dir = ".pnpm/${sanitize key}/node_modules/${name}";
      in
      ''
        mkdir -p "$out/${dir}"
        tar -xzf ${tarballs.${key}} -C "$out/${dir}" --strip-components=1 --no-same-owner
      ''
    ) (lib.filterAttrs (key: _: tarballs ? ${key}) lock.snapshots)
  );

  linkCommands = lib.concatStrings (
    lib.mapAttrsToList (
      key: snap:
      lib.concatStrings (
        lib.mapAttrsToList (depName: depVersion: ''
          mkdir -p "$(dirname "$out/.pnpm/${sanitize key}/node_modules/${depName}")"
          ln -sfn "$out/.pnpm/${sanitize "${depName}@${depVersion}"}/node_modules/${depName}" \
            "$out/.pnpm/${sanitize key}/node_modules/${depName}"
        '') (edgesOf snap)
      )
    ) (lib.filterAttrs (key: _: tarballs ? ${key}) lock.snapshots)
  );

  rootLinkCommands = lib.concatStrings (
    lib.mapAttrsToList (name: version: ''
      mkdir -p "$(dirname "$out/${name}")"
      ln -sn "$out/.pnpm/${sanitize "${name}@${version}"}/node_modules/${name}" "$out/${name}"
    '') (lib.filterAttrs (name: version: tarballs ? "${name}@${version}") rootDeps)
  );
in

assert lib.assertMsg (lib.hasPrefix "9." (toString lock.lockfileVersion))
  "importPnpmLock: only lockfileVersion 9.x is supported (got ${toString lock.lockfileVersion})";
assert lib.assertMsg (builtins.attrNames lock.importers == [ "." ])
  "importPnpmLock: only single-importer (non-workspace) lockfiles are supported";

pkgs.runCommand "node-modules"
  {
    # node_modules must stay exactly as the tarballs shipped it — no shebang
    # patching or stripping, which would also break foreign-format binaries.
    dontFixup = true;
  }
  ''
    mkdir -p $out/.pnpm
    ${unpackCommands}
    ${linkCommands}
    ${rootLinkCommands}
  ''
