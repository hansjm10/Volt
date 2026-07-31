# Initial npm Release Bootstrap

> Completed for all four packages and the `0.1.0` beta. This document retains
> the one-time reservation rationale. Do not rerun bootstrap for normal
> releases; use [GitHub-Native Release Automation](github-release-automation.md).

The four Volt package names are declared in their package manifests:

- `@hansjm10/volt-ai`
- `@hansjm10/volt-agent-core`
- `@hansjm10/volt-tui`
- `@hansjm10/volt-coding-agent`

The initial Volt beta used lockstep version `0.1.0` and the npm `beta` dist-tag.
Before releasing it, reserve the four names with a non-installable
`0.0.0-bootstrap.0` placeholder under the `bootstrap` dist-tag. npm requires
every package to have a `latest` tag, so `latest` also remains pinned to this
inert placeholder throughout the beta. This creates the
npm package settings needed for trusted publishing without consuming the real
version or publishing release code outside the tagged CI workflow.

The owner of the `hansjm10` npm scope must perform the one-time bootstrap
outside the automated release:

1. Confirm that the npm account owns the `@hansjm10` scope and that public
   repository metadata points to `volt-hq/Volt`.
2. Review the reservation helper, then check all four names without changing
   npm:

   ```sh
   node scripts/bootstrap-npm-packages.mjs
   ```

   The command fails closed if any name contains content other than Volt's exact
   bootstrap placeholder. Authenticate interactively with npm, then explicitly
   create any missing reservations:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   node scripts/bootstrap-npm-packages.mjs --publish
   ```

   The helper creates temporary minimal packages outside the repository source,
   publishes them as public in dependency order, verifies each result, and
   removes the temporary files. It never publishes `0.1.0` or creates `beta`;
   npm automatically points its required `latest` tag at the inert placeholder.
   A partial network failure is safe to retry: exact
   placeholders are verified and skipped.
3. For each reserved package, configure npm trusted publishing for GitHub
   repository `volt-hq/Volt`, workflow filename `build-binaries.yml`,
   environment `npm-publish`, with `npm publish` allowed. Then set package
   publishing access to require two-factor authentication and disallow tokens,
   and revoke any obsolete automation publish tokens. Trusted OIDC publication
   continues to work without leaving a long-lived credential.
4. Configure a GitHub repository ruleset for `refs/tags/v*` that restricts tag
   creation, update, and deletion to release owners. Do not rely on checks that
   run from the tagged commit as a substitute for this repository-level rule.
5. Configure the GitHub `binary-release` environment with administrator bypass
   disabled and restrict deployments to protected `v*` tags. In the current
   solo-maintainer workflow, complete and record the exact standalone-binary
   license review before creating the release tag; tag creation is the release
   owner's authorization for the final release job.
6. Before the first real release, verify each package with
   `npm view <name>@0.0.0-bootstrap.0 name versions license dist-tags repository --json`.
   The explicit selector avoids resolving through `latest`. Before the real
   release, the only version must be `0.0.0-bootstrap.0`; `bootstrap` and
   npm-required `latest` must both point to it; `beta` and `0.1.0` must be
   absent.
7. After trusted publication, verify each real package with
   `npm view <name>@0.1.0 name version license dist-tags repository --json`.
   Confirm that `beta` resolves to `0.1.0`, `latest` remains pinned to the inert
   `0.0.0-bootstrap.0` placeholder, and the npm provenance links to
   `volt-hq/Volt` and the release workflow. Beta users must install with
   `@beta`; an unqualified install intentionally resolves to the placeholder.
8. Verify the final GitHub release assets and checksums match the approved
   candidate and release record.
9. Starting with stable `0.2.0`, publish all four packages under `latest`, keep
   `beta` on the historical `0.1.0`, and keep `bootstrap` on
   `0.0.0-bootstrap.0`. Unqualified npm installs then resolve to the current
   stable release.

npm requires a package to exist before a trusted-publisher relationship can be
configured. Only the non-installable name-reservation placeholder uses the npm
account's approved interactive authentication; `0.1.0` and subsequent versions
use the trusted publisher. Do not add a long-lived publish token to the
workflow as a shortcut.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
