# Vendored build-time files — do not edit in place

Two files in this directory are vendored copies of upstream files.
They are used by the Debian packaging build (prepare-deb) and are
NOT downloaded at build time (alpha.35, vendor B1: the GitHub
contents API rate-limited the downloads from the CI runner —
SIG-B34-01 in the alpha.34 run). Both files are validated on every
build before use; a mismatch fails the build loudly. Do not edit
either file by hand: replace it wholesale with the upstream file
and update its pin in the same commit (see "Updating" below).

## dpkg-shlibdeps.pl

- Upstream: chromium/chromium, `third_party/dpkg-shlibdeps/dpkg-shlibdeps.pl`
  (a copy of the dpkg project's dpkg-shlibdeps tool, Debian).
- Pinned at: Chromium 150.0.7871.250, commit
  f916f1b7136907af19d96b95b891533d091d932a (cgmanifest.json
  registration "chromium" in the repository root).
- Size / SHA-256: 31,983 bytes /
  71b61bee790bf06797c901334f60b916c41f8346f9f8c333f9fa378d7e3b05bd
  (enforced by DPKG_SHLIBDEPS_SHA256 in ../calculate-deps.ts).
- License: GNU General Public License v2 or later (GPL-2.0+).
  Copyright (c) 1996 Ian Jackson, (c) 2000 Wichert Akkerman,
  (c) 2006 Frank Lichtenheld, (c) 2006-2010,2012-2015 Guillem
  Jover, (c) 2007,2016 Raphaël Hertzog. The full license header
  is inside the file itself and must be preserved byte-for-byte;
  the SHA-256 pin above guarantees that it is.
- Role: build-time only. It is executed with perl on the build
  machine to compute shared-library dependencies; it is not
  shipped in the packaged product.
- Retrieved: 2026-10-22, via the GitHub contents API; content
  verified byte-identical against the pin from two independent
  measurements (mission BUILD-VERIFY-13/14 records).

## sysroots.json

- Upstream: electron/electron, `script/sysroots.json`.
- Pinned at: Electron v43.7.7, commit
  ddb762f50fbd70384d0385302697e60ada549024 (cgmanifest.json
  registration "electron"; .npmrc target 43.7.7).
- Size / SHA-256: 3,024 bytes / 2fcdb40d559e8e5334618afca7da27f7e3b40321780372f3fed4e40585805e6c
  (enforced by SYSROOTS_JSON_SHA256 in ../install-sysroot.ts —
  omit this clause if lane C does not adopt the pin).
- License: MIT (the Electron project's license, as registered
  for the electron component in cgmanifest.json). The file is
  configuration data only: sysroot tarball names, SHA-256 sums
  and directory names.
- Role: build-time only. It selects which Chromium sysroot
  tarball to download and verify; it is not shipped in the
  packaged product.
- Retrieved: 2026-10-22, via the GitHub contents API; content
  verified byte-identical across three independent sources
  (mission BUILD-VERIFY-13 records).

## Updating

When the Chromium registration in cgmanifest.json moves:
replace dpkg-shlibdeps.pl with the file at the new Chromium
version and update DPKG_SHLIBDEPS_SHA256 in ../calculate-deps.ts
in the same commit. When the Electron version (.npmrc target)
moves: replace sysroots.json with the file at the new tag and
update SYSROOTS_JSON_SHA256 in ../install-sysroot.ts in the same
commit. After replacing a file, run
`sha256sum <file>` and compare against the new pin before
committing — a stale pin or a stale file fails the build by
design.
