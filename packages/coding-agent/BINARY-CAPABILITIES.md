# Standalone Binary Capabilities

The prebuilt executable is a local Volt CLI/TUI distribution built as a
Node.js 22.23.1 Single Executable Application. It supports local interactive
and print-mode agent sessions.

It does **not** include the optional native `@hansjm10/volt-iroh` adapter and cannot
run `volt daemon` or provide remote/iOS access. Install
`@hansjm10/volt-coding-agent` through npm for daemon and remote support.

Release binaries are built natively for macOS arm64/x64, Linux arm64/x64, and
Windows arm64/x64. Each archive includes its matching capability-rooted
workspace filesystem addon and the generated Rust dependency license
inventory. The official Node.js Linux binaries require glibc 2.28 or newer and
do not support Alpine/musl, even though the npm package also carries musl
workspace-filesystem prebuilds. Windows beta executables are not
Authenticode-signed; verify the release archive against the published
`SHA256SUMS` before running it. macOS binaries are ad-hoc signed after SEA
injection, not Developer ID notarized.

The standalone's pure-JavaScript image pipeline locally decodes and resizes
PNG, JPEG, GIF, and BMP. WebP can be sent through when it already fits the
inline limits, but this beta does not locally resize WebP or convert it to PNG
for Kitty-protocol terminal previews.

The repository-only `examples/extensions/doom-overlay` example and the Iroh
remote demo are excluded from standalone archives. See `THIRD-PARTY-NOTICES.md`
and the archive's generated `binary-license-manifest.json` for the exact
embedded runtime and JavaScript license inventory. Rust notices are under
`LICENSES/workspace-fs-rust/`. `standalone-file-manifest.json` records the
checksum, size, and mode of every other staged archive file, including the
matching native addon and notices.
