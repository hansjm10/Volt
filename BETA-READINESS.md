# Volt Beta Release Gates

The npm CLI/daemon and standalone binaries are **not ready for public beta
distribution** until every hard gate below is closed. Source development and
internal testing can continue while these external release prerequisites are
completed.

## Hard gates

- [x] **Bootstrap npm publishing.** Reserve the four public
  `@hansjm10/volt-*` names with the non-installable `0.0.0-bootstrap.0`
  placeholder under `bootstrap`, with npm-required `latest` also pinned to that
  inert placeholder, configure the `build-binaries.yml` trusted publisher for
  the `npm-publish` environment, and publish lockstep `0.1.0`
  under `beta` with provenance. Follow
  [Initial npm Release Bootstrap](docs/npm-release-bootstrap.md); do not publish
  the beta as `latest` and do not substitute a long-lived npm token for trusted
  publishing.
- [x] **Approve standalone-binary license compliance.** Standalone artifacts
  use the official Node.js 26.8.1 runtime as a Single Executable Application,
  replacing the previous standalone runtime design. The runtime version,
  per-platform archive checksums, exact consolidated Node license, and license
  checksum are pinned in `compliance/standalone-runtime.json`.

  For the exact release commit, confirm that every native build verifies its
  pinned runtime archive, includes
  `LICENSES/node-v26.8.1-LICENSE.txt`, and emits both
  `binary-metafile.json` and `binary-license-manifest.json`. Review the
  manifest's metafile checksum, embedded npm package identities, copied
  license-file checksums, and any checksum-pinned overrides. Verify
  `standalone-file-manifest.json` accounts for every other staged archive file.
  Confirm the npm package and all standalone archives exclude
  `examples/extensions/doom-overlay`, and contain only components represented
  by the pinned runtime license or generated bundle inventory. See
  [Third-Party Notices](THIRD-PARTY-NOTICES.md).

  Build and smoke-test the native matrix: macOS arm64/x64, Linux arm64/x64,
  and Windows arm64/x64. The official Linux runtime requires glibc 2.28 or
  newer and does not support Alpine/musl. Windows executables are not
  Authenticode-signed; verify and record this disclosure and the final archive
  checksums before inviting testers.

  For subsequent releases, run **Prepare Release** and merge its pull request,
  then dispatch `build-standalone-candidate.yml` with the resulting exact
  lowercase 40-character `main` SHA. The workflow builds all six native
  archives and publishes a 30-day artifact containing `source-commit.txt`,
  `SHA256SUMS`, and `release-record.json`, with GitHub attestations for every
  archive and the record. It cannot publish npm packages, create a tag, or
  create a release. Download that artifact, record its run ID and exact
  `sha256:` artifact digest, and perform this compliance review against those
  exact bytes.

  **Do not run Approve Release until the release owner approves and records
  this compliance gate for the exact commit, run, artifact digest, and native
  bytes.** The owner-only workflow requires the exact authorization phrase and
  acknowledgements, creates the annotated tag through the repository-scoped
  Release Tagger App, and dispatches publication at that tag. The
  `binary-release` environment has administrator bypass disabled and accepts
  protected `v*` tags only. It has no secrets or reviewer requirement.
- [x] **Resolve Doom source-archive provenance.** The unverified generated Doom
  JavaScript/WebAssembly and Doom artwork have been removed from the repository.
  The remaining source-only demo ignores generated output, cloned upstream
  source, and the downloaded WAD; its optional local build pins the exact
  DoomGeneric source commit and warns that redistributed output is GPL-2.0.
  The npm package and custom standalone archives continue to exclude the whole
  demo as defense in depth.
- [x] **Prove the npm daemon distribution.** From an unpublished package
  installed outside the repository, run the full Node smoke test in
  [AGENTS.md](AGENTS.md#releasing). Then use an isolated
  `VOLT_CODING_AGENT_DIR` to start a relay-disabled `volt daemon`, poll `volt
  daemon status --json` until `remoteTransport.state` is `ready`, register a
  disposable workspace, and always stop that isolated daemon. Confirm the
  required exact `@hansjm10/volt-iroh` wrapper and its optional selected native
  binding load on macOS arm64, Linux x64/arm64 (glibc and musl), and Windows
  x64/arm64. Installs use npm 11.17.0; the two-day release-age quarantine keeps
  applying to third-party packages and exempts only Volt's self-packaged
  `@hansjm10/volt-iroh*` family. `--omit=optional` keeps the wrapper but cannot
  provide phone transport. The pinned adapter has no Darwin x64 binding, so
  Intel macOS npm installs remain explicitly local CLI/TUI only. Standalone Node
  SEA binaries intentionally exclude Iroh on every platform and must reject
  daemon/remote commands; see
  [Binary Capabilities](packages/coding-agent/BINARY-CAPABILITIES.md).

  The release owner confirmed this gate complete on 2026-07-12 after extensive
  daemon and physical-iPhone deployment, pairing, reconnect, and session testing.
- [x] **Create one auditable release source.** The canonical annotated
  `v0.1.0` tag, four lockstep npm packages, and GitHub prerelease are published
  from the same main commit and reviewed native candidate. The tag is protected
  against creation, update, and deletion by a repository ruleset. Subsequent
  releases use the GitHub-native prepare, candidate, approval, tag, npm, and
  draft-release flow documented in
  [GitHub-Native Release Automation](docs/github-release-automation.md). The
  publisher promotes the reviewed archives without rebuilding and refuses to
  replace an existing asset with different bytes.

## Release-owner sign-off

For every subsequent release, record the npm bootstrap/channel verification,
candidate workflow run, exact candidate commit, workflow run ID, artifact
digest, attestation verification, `source-commit.txt`, runtime and binary-license
manifest approval, native-platform smoke results, unsigned-Windows disclosure,
owner authorization run, protected annotated tag, and generated checksums
before inviting users.
