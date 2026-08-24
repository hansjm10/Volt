# Third-Party Notices

Volt uses third-party software under its own license terms. The authoritative
versioned dependency inventory for the npm CLI is `npm-shrinkwrap.json`;
npm-installed dependencies retain the license files shipped in their own
packages.

## Standalone binary inventory

Standalone releases are built as Node.js Single Executable Applications
(SEA), using the official Node.js 22.23.1 runtime archive pinned for each
target in `compliance/standalone-runtime.json`. Every standalone archive
includes the exact consolidated Node.js license and third-party notices as
`LICENSES/node-v22.23.1-LICENSE.txt`. The committed source copy and SHA-256
checksum are recorded in the runtime configuration.

The JavaScript bundle has a separate, build-derived inventory:

- `binary-metafile.json` records the exact source inputs embedded by esbuild.
- `binary-license-manifest.json` records the metafile checksum, every embedded
  npm package identity, its declared license, the copied license files, and
  their SHA-256 checksums.
- `LICENSES/npm/` contains the license files referenced by that manifest.
- `standalone-file-manifest.json` records the path, mode, size, and SHA-256
  checksum of every other staged archive file.

The HTML export assets also redistribute vendored Highlight.js 11.9.0 and
Marked 18.0.5 browser bundles under `export-html/vendor/`. Their exact licenses
are included as `LICENSES/highlight.js-11.9.0-BSD-3-Clause.txt` and
`LICENSES/marked-18.0.5-LICENSE.txt`. These copies track the staged browser
assets independently of the server bundle inventory.

License collection fails when an embedded npm package has no authoritative
license file. The small number of packages whose npm tarballs omit their
repository-level license use checksum-pinned, version- or commit-specific
authoritative copies declared in `compliance/npm-license-overrides.json`.

The workspace filesystem foundation includes a Rust Node-API addon. Its
checksum-pinned artifact manifest is `native/workspace-fs/prebuilds/manifest.json`.
The generated `native/workspace-fs/licenses/inventory.json` records the exact
Cargo dependency versions, declared licenses, selected licenses, source/Cargo
fingerprint, and checksums of every redistributed Rust license text. The npm
package carries all eight supported prebuilds and this complete license tree;
each standalone archive carries only its matching addon plus the same native
license inventory and texts under `LICENSES/workspace-fs-rust/`.

The npm CLI optionally installs `@hansjm10/volt-iroh@1.1.1-volt.2`, Volt's
MIT/Apache-2.0 fork of Iroh FFI 1.1.0; its root and native platform packages
ship their own license texts and provenance. The standalone archive carries
Volt's MIT license and this notice but intentionally does not bundle that
native adapter, so a standalone executable cannot host `volt daemon` or
provide remote/iOS access. Use the npm package or a source checkout for those
features.

The source-only `examples/extensions/doom-overlay` demo remains in the
repository, but is excluded from both the published npm package and standalone
archives. Volt does not redistribute its Doom screenshot, WAD, cloned
DoomGeneric source, or generated GPL JavaScript/WebAssembly. The optional local
build script pins DoomGeneric source commit
`dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284`; its ignored outputs remain subject
to DoomGeneric's GPL-2.0 license if a user chooses to redistribute them.

This notice is not a substitute for the applicable license texts or the
release owner's review. Before creating a public release tag, verify the
runtime archive checksum, generated metafile and license manifest, copied
license bytes, staged-file manifest, archive exclusions, and final release
checksums for that exact release.
