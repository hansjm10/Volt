# GitHub-Native Release Automation

> Status: active since 2026-07-13. The one-time GitHub configuration is
> installed, the test-prefix exercise passed, and production release tags are
> authorized only through the repository-scoped Release Tagger App.

The GitHub-native release flow moves release preparation, native candidate
building, approval, tagging, npm publication, and GitHub Release publication
into auditable GitHub workflows. It preserves the existing rule that a release
owner must inspect and approve the exact standalone bytes before a release tag
exists.

The normal flow uses no personal access token and never publishes npm packages
with a stored npm token. npm publication continues to use trusted publishing
with GitHub Actions OIDC.

## Activation record

- Protected `main` ruleset: `18875265`; pull requests and the
  `build-check-test` GitHub Actions check are required, with zero required
  approving reviews and no bypass actors.
- Actions policy: GitHub-owned actions only, full-SHA pinning required,
  read-only default `GITHUB_TOKEN`, and the combined create/approve-pull-request
  repository toggle enabled. Volt workflows never approve or merge a pull
  request.
- Release App: `Volt Release Tagger hansjm10`, App ID `4287315`; installed only
  on `volt-hq/Volt` with `Contents: write` and mandatory `Metadata: read`.
- Release authorization environment: `release-authorization`; `main` only,
  administrator bypass disabled, no reviewers, and no wait timer.
- Release-tag creation ruleset: `18846707`; `v*` creation is restricted and
  only App ID `4287315` may bypass it.
- Release-tag mutation ruleset: `18876498`; `v*` updates and deletions are
  restricted with no bypass actors.
- Immutable releases are enabled for future releases.
- Activation CI passed in [run 29250095530](https://github.com/volt-hq/Volt/actions/runs/29250095530).
  The protected-main exercise workflow was introduced through
  [PR 22](https://github.com/volt-hq/Volt/pull/22), and the complete
  authorization exercise passed in
  [run 29254385483](https://github.com/volt-hq/Volt/actions/runs/29254385483)
  at commit `0dbfe2ee8c34c5686c09c767d415a2d1ebcc34c3`.
- The exercise verified ordinary `GITHUB_TOKEN` creation denial, annotated App
  creation, App update denial, App deletion denial, owner cleanup, and removal
  of the temporary tag and rulesets `18875873` and `18875868`.

## Security invariants

- All four npm packages remain lockstep versioned.
- The release commit must be the exact current commit on protected `main`.
- The approved candidate commit, workflow run, artifact digest, attestation,
  `source-commit.txt`, and archive checksums must all identify the same bytes.
- A release owner must acknowledge the binary-license review, native smoke-test
  results, and unsigned-Windows disclosure before a `v*` tag is created.
- The tag is annotated and records the candidate and approval identities.
- Release tags cannot be updated or deleted by automation.
- The publisher runs only through `workflow_dispatch` at an existing release
  tag. It has no tag-creation path.
- npm publishes before standalone binaries become public.
- A rerun resumes the same immutable tag and exact artifacts. It never moves,
  deletes, or recreates a release tag.

GitHub documents creation, update, and deletion as separate tag-ruleset rules.
Only configured bypass actors can perform a restricted operation. GitHub Apps
are eligible bypass actors. See [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
and [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

## Workflows

The workflow files are:

- `.github/workflows/prepare-release.yml` — **Prepare Release**
- `.github/workflows/build-standalone-candidate.yml` — **Build Standalone Candidate**
- `.github/workflows/approve-release.yml` — **Approve Release**
- `.github/workflows/build-binaries.yml` — **Publish Release**

All workflows must set top-level `permissions: {}` and grant permissions only
to the jobs that require them. All external actions, including actions owned by
GitHub, must be pinned to full commit SHAs. GitHub recommends minimum
`GITHUB_TOKEN` permissions and full-SHA action pinning in its
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### 1. Prepare Release

**Prepare Release** is manually dispatched from `main`. It accepts the release
target, validates registry and repository state, runs the release preparation
logic, and opens a release pull request. It must not push directly to `main` or
create a tag.

For normal releases, the target is one of:

- `patch` for fixes and additions
- `minor` for breaking changes

The one-time `0.1.0` initial-release target is not part of the recurring flow.

The preparation job must:

1. Require `github.ref == refs/heads/main` and start from the current protected
   `main` commit.
2. Verify lockstep package versions, pending changesets, npm availability, and
   tag absence.
3. Regenerate release-controlled files and run the required checks and tests.
4. Create a release branch and pull request containing only the reviewed
   release changes.
5. Report the planned version and expected post-merge validation steps.

The repository owner reviews the pull request's generated changelog section,
package metadata, lockfiles, shrinkwrap, and generated artifacts, waits for
required checks, and merges it. Consumed `.changeset/` fragments are deleted in
the same commit. The candidate SHA is the resulting commit on `main`, not the
pre-merge release-branch SHA.

The prepare job uses a write-scoped ordinary `GITHUB_TOKEN` only after all
repository code and release checks have finished. It pushes a release branch,
and opens the pull request. GitHub places `pull_request` runs caused by
`GITHUB_TOKEN` in an approval-required state, so the owner must click
**Approve workflows to run** on the generated pull request. Those checks test
GitHub's pull-request merge ref; a branch-head dispatch is not used as a
substitute. The automation never approves or merges its own pull request.

A manually dispatched workflow must exist on the default branch, and a user
needs write access to run it from the Actions UI. See
[Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

### 2. Build Standalone Candidate

After the release pull request is merged, **Build Standalone Candidate** runs
for the exact lowercase 40-character `main` SHA. It must reject a commit that
does not exactly equal the current remote `main` tip, and both the original and
rerun actor must be the repository owner.

The workflow builds and smoke-tests the native matrix:

- macOS arm64 and x64
- Linux arm64 and x64
- Windows arm64 and x64

It then assembles one combined review artifact containing exactly nine
top-level files:

- the six native archives
- `SHA256SUMS`
- `source-commit.txt`
- `release-record.json`

The required binary, file, and license manifests are inside each native
archive. They are not additional top-level files in the combined artifact.

The workflow reports these approval inputs in its summary:

- candidate commit SHA
- positive decimal workflow run ID
- combined artifact name and artifact ID
- combined artifact digest in `sha256:<64 lowercase hex>` form
- attestation verification command

The combined artifact and every promoted release archive must receive build
provenance. GitHub's artifact-attestation flow requires:

```yaml
permissions:
  contents: read
  id-token: write
  attestations: write
```

See [Using artifact attestations to establish provenance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
The candidate workflow therefore has narrowly scoped attestation-write access,
but it has no repository-contents write, tag, npm-publish, or release-publish
permission.

The owner downloads the combined artifact and completes the release review
before starting **Approve Release**. At minimum, the owner verifies:

- `source-commit.txt` equals the candidate SHA;
- all six `SHA256SUMS` entries pass;
- every archive's file and binary-license manifests pass review;
- Node runtime and copied license checksums match the pinned compliance data;
- prohibited generated artifacts and excluded examples are absent;
- native smoke-test results are acceptable; and
- Windows executables remain intentionally unsigned and that fact is disclosed
  in the release notes.

### 3. Approve Release

**Approve Release** is a manual workflow on `main`. Its inputs are:

| Input | Type | Requirement |
| --- | --- | --- |
| `version` | string | Canonical `MAJOR.MINOR.PATCH` matching all packages and the changelog |
| `candidate_commit` | string | Exact lowercase 40-character SHA at current `main` |
| `candidate_run_id` | string | Positive decimal Build Standalone Candidate run ID |
| `candidate_artifact_digest` | string | Exact `sha256:<64 lowercase hex>` combined-artifact digest |
| `license_compliance_approved` | boolean | Must be true after manifest and license review |
| `native_smoke_tests_approved` | boolean | Must be true after the required smoke tests |
| `unsigned_windows_acknowledged` | boolean | Must be true after reviewing the disclosure |
| `authorization_phrase` | string | Must exactly bind the version, SHA, run, and digest as specified below |
| `confirm_release` | boolean | Must be true to request tag creation and publication |

For a solo-maintainer repository, authorization is the owner-only manual
dispatch plus the exact typed phrase and boolean acknowledgements. The
`authorization_phrase` must be exactly, with values substituted verbatim:

```text
release v<version> from <candidate_commit> using run <candidate_run_id> and <candidate_artifact_digest>
```

The workflow validates all inputs in an unprivileged preflight job. The tag job
uses the `release-authorization` environment only to isolate the App credential
and restrict it to runs from `main`; the environment has no required reviewer.

Preflight must fail unless all of the following are true:

- both `github.actor` and `github.triggering_actor` are the repository owner;
- the workflow runs from `refs/heads/main`;
- `candidate_commit` is the exact current `main` commit;
- the prepared commit, package versions, and the product changelog heading
  match `version`, with no unconsumed `.changeset/` fragments;
- `v<version>` is absent locally and remotely and the npm versions are
  available;
- the candidate run is a successful `workflow_dispatch` run of
  `build-standalone-candidate.yml` on `main` for `candidate_commit`;
- the expected combined artifact is unexpired and its API digest exactly
  matches `candidate_artifact_digest`;
- the downloaded artifact, `source-commit.txt`, archive set, checksums, and
  attestations pass verification;
- `authorization_phrase` exactly matches the required phrase after substituting
  the validated values; and
- every boolean acknowledgement input is true.

After preflight, the tag job enters `release-authorization` without a deployment
review step. It repeats all mutable external-state checks before it mints a
credential.

The authorized tag job then creates an annotated tag with a message containing:

```text
Release v<version>

Standalone-Candidate-Commit: <candidate_commit>
Standalone-Candidate-Run: <candidate_run_id>
Standalone-Candidate-Artifact-Digest: <candidate_artifact_digest>
Release-Approval-Run: <approve-release workflow run ID>
```

The job creates the annotated tag object and then `refs/tags/v<version>` using
GitHub's Git database APIs. Both operations require `Contents: write`; see the
[tag-object API](https://docs.github.com/en/rest/git/tags) and
[reference API](https://docs.github.com/en/rest/git/refs). It never uses a
force update and fails if the reference already exists. It reads the tag back
and verifies the tag object, target commit, and message before continuing.

The same authorized job creates or verifies the stable draft release for the
exact new tag. Drafts cannot be marked latest, so the publisher marks it latest
atomically when publishing. Approval fails if a release already exists in any
other state.

Finally, a separate job grants the ordinary `GITHUB_TOKEN` only
`actions: write` and dispatches **Publish Release** with `ref` set to the new
tag. A `GITHUB_TOKEN`-created push does not normally trigger another workflow,
while `workflow_dispatch` and `repository_dispatch` are explicit exceptions.
See [GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token).

### 4. Publish Release

**Publish Release** has only a `workflow_dispatch` trigger. It must not have a
`push`, `create`, `release`, `workflow_run`, or `repository_dispatch` trigger.
The dispatch uses `ref: v<version>`, which makes the release tag the workflow
ref and allows tag-restricted environment policies to apply. GitHub's workflow
dispatch API accepts a branch or tag ref and requires `Actions: write`; see
[Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Before any publication, the workflow verifies:

- `github.ref == refs/tags/v<version>`;
- the checked-out tag is annotated and targets the approved commit;
- the tag message contains exactly one matching candidate commit, run ID,
  artifact digest, and approval run ID;
- the tag commit is reachable from protected `main`;
- package versions and the product changelog match the tag;
- the candidate run, artifact, attestation, source commit, archive set, and
  checksums still match; and
- no existing npm version, dist-tag, draft release, published release, or
  release asset conflicts with the exact approved bytes.

Publication is divided into least-privilege jobs:

1. **Assemble** downloads and reverifies the approved candidate and uploads a
   promotion artifact for downstream jobs. It has `contents: read` and
   `actions: read` only.
2. **Publish npm** uses the `npm-publish` environment with `contents: read` and
   `id-token: write`. It builds, checks, tests, packs, and publishes the four
   packages in dependency order under `latest` through npm trusted publishing.
   It preserves `bootstrap` on the inert placeholder and `beta` on the
   historical `0.1.0`. Existing versions are skipped only after exact integrity,
   provenance, repository, and dist-tag verification.
3. **Publish GitHub Release** runs only after npm succeeds. It uses the
   `binary-release` environment and receives `contents: write`. It requires the
   exact stable draft created by **Approve Release**; it never creates a
   release. It uploads exactly eight public assets: the six approved archives,
   `SHA256SUMS`, and `release-record.json`. `source-commit.txt` and the release
   notes are verified internal publication inputs, not public assets. It
   verifies every uploaded asset digest and publishes the draft only after the
   full asset set passes verification.

Repository release immutability is enabled and must remain enabled. Once an
immutable release is published, GitHub locks its tag and assets and
automatically generates a release attestation. GitHub recommends creating a
draft, attaching every asset, and then publishing it. See
[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
and [Preventing changes to releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).

## One-time GitHub setup

This configuration is installed. Reproduce these steps in order after a
repository migration or authorization redesign, and do not reactivate
production tag creation until the test-prefix exercise passes again.

### 1. Register the Volt Release Tagger GitHub App

From the owner account, open **Settings → Developer settings → GitHub Apps →
New GitHub App** and configure:

- **GitHub App name:** `Volt Release Tagger hansjm10`
- **Homepage URL:** `https://github.com/volt-hq/Volt`
- **User authorization callback URL:** unset
- **Request user authorization during installation:** disabled
- **Webhook:** inactive; no webhook secret and no subscribed events
- **Where can this GitHub App be installed?:** only this account
- **Repository permissions:**
  - `Contents`: **Read and write**
  - `Metadata`: **Read-only** (GitHub's required baseline)
  - every other repository permission: **No access**
- **Organization permissions:** all **No access**
- **Account permissions:** all **No access**

GitHub Apps have no permissions by default, and GitHub recommends granting only
the permissions their API calls require. See
[Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

Install the App on **Only select repositories → Volt**. Do not install it on
all repositories. See [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

Generate one private key, download it once, add it to the isolated environment
in the next step, and remove unnecessary local copies. Record the GitHub App
client ID. Do not grant the App `Actions`, `Administration`, `Workflows`, `Deployments`,
`Secrets`, `Environments`, `Packages`, or `Pull requests` permission.

The approval workflow exchanges the App client ID and private key for an
installation token restricted to `volt-hq/Volt` and `contents: write`. GitHub
App installation tokens expire after one hour and can be narrowed to selected
repositories and permissions. See
[Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

The token-minting step passes `vars.VOLT_RELEASE_APP_CLIENT_ID` as `client-id`,
`secrets.VOLT_RELEASE_APP_PRIVATE_KEY` as `private-key`, and
`permission-contents: write`. With no owner or repository override, the action
restricts the installation token to the current repository. It must run only
after the repeated tag preconditions and must not persist the installation
token as an artifact or pass it to another job.

### 2. Configure the release-authorization environment

Open **Volt → Settings → Environments → New environment** and create
`release-authorization` with:

- **Required reviewers:** none; this repository currently has one release owner
- **Allow administrators to bypass configured protection rules:** off
- **Deployment branches and tags:** selected branches, branch `main` only;
  do not allow tags or pull-request refs
- **Environment variable:**
  - `VOLT_RELEASE_APP_CLIENT_ID` — the GitHub App client ID
- **Environment secret:**
  - `VOLT_RELEASE_APP_PRIVATE_KEY` — the complete PEM private key, including
    its BEGIN and END lines
- **Other secrets:** none

The secret must not also exist as a repository or organization secret. Only the
authorized tag job may reference this environment. No build, test, pull-request,
candidate, npm, or release-asset job may receive the private key. The
environment isolates the credential and restricts its ref; it does not add an
approval click. Owner identity, the exact typed phrase, and the boolean
acknowledgements are the authorization boundary.

Environment secrets and selected branch/tag policies are documented in
[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

### 3. Split production tag rulesets

Open **Volt → Settings → Rules → Rulesets** and create two active tag rulesets.

#### Protect release tag creation (`18846707`)

- **Target:** tags matching `v*`
- **Rule:** Restrict creations
- **Bypass list, always allow:** `Volt Release Tagger`
- Do not enable update or deletion rules in this ruleset.

The repository owner may remain an owner-level break-glass bypass actor for
creation if GitHub's personal-repository role model requires it, but normal tag
creation must use the authorized App job.

#### Protect release tag mutations (`18876498`)

- **Target:** tags matching `v*`
- **Rules:** Restrict updates and Restrict deletions
- **Bypass list:** do not add `Volt Release Tagger`
- Prefer no bypass actors. If an owner-level emergency bypass is retained, it
  is incident-only and never part of the release or recovery runbook.

Splitting the rulesets is intentional. The App is authorized to create a new
approved tag, but it cannot update or delete any existing `v*` tag even though
its underlying `Contents: write` permission is also sufficient for the update
and delete APIs.

Do not add the general GitHub Actions App or a write-role wildcard to either
bypass list. That would make every sufficiently privileged repository workflow
a release-tag actor.

### 4. Configure publication environments

Keep or create these environments:

#### npm-publish

- administrator bypass disabled
- selected deployment tags: `v*` only
- no environment secrets
- required reviewers: none

Configure each npm package's trusted publisher for:

- repository: `volt-hq/Volt`
- workflow filename: `build-binaries.yml`
- environment: `npm-publish`

Keep the existing `build-binaries.yml` filename so all four npm trusted
publishers remain aligned. If that filename is ever changed, update all four
npm package settings together so a mixed configuration cannot partially
publish a release.

#### binary-release

- administrator bypass disabled
- selected deployment tags: `v*` only
- no environment secrets
- no required reviewer; owner-only Approve Release inputs authorize the tag

GitHub matches selected deployment branches and tags against the workflow run's
`GITHUB_REF`, which is why the publisher is dispatched at the tag ref.

### 5. Enable immutable releases

Open **Volt → Settings → General → Releases** and enable release immutability.
This applies only to future releases. Confirm the setting before enabling the
production approval workflow.

### 6. Configure Actions defaults

- Set the repository's default `GITHUB_TOKEN` permission to read-only.
- Enable **Allow GitHub Actions to create and approve pull requests** so the
  prepare workflow can open pull requests. The workflows do not request
  review-approval permission and never approve or merge a pull request; GitHub
  currently exposes creation and approval under one repository setting.
- Require every workflow to declare top-level `permissions: {}` and add
  job-level permissions explicitly.
- Require actions to be pinned to full-length commit SHAs where the repository
  plan exposes that policy.
- Add a release concurrency group so only one prepare, approve, or publish flow
  can be active for a version at a time. Do not cancel an in-progress publish.
- Protect changes to release workflows and release scripts through the normal
  protected-`main` pull-request path.

Create an active `main` branch ruleset that requires a pull request and the CI
check before merge. Configure zero required approving reviews while the
repository has one maintainer, do not require Code Owner approval, and do not
allow direct pushes as the normal path. Require the branch to be up to date so
the required CI result covers GitHub's current merge ref. The
contributor-approval automation and release preparation open pull requests so
this rule does not require an exception for routine work.

GitHub describes job-level `GITHUB_TOKEN` permission controls in
[Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

## Operator runbook

### Prepare and merge

1. Open **Actions → Prepare Release → Run workflow**.
2. Select branch `main`.
3. Choose `patch` or `minor` and run the workflow.
4. Open the generated release pull request.
5. Click **Approve workflows to run** so the PR checks execute against the
   merge ref.
6. Review the generated changelog section, every package version, dependency
   metadata file, generated artifact, and workflow result.
7. Merge only after all required checks pass.
8. Copy the resulting full `main` commit SHA.

If preparation is wrong, close the pull request. Because no tag or package has
been created, prepare a replacement pull request normally.

### Build and inspect the candidate

1. Open **Actions → Build Standalone Candidate → Run workflow** if it was not
   dispatched automatically.
2. Select branch `main` and paste the exact post-merge commit SHA.
3. Wait for every native build and assemble job to pass.
4. From the workflow summary, copy the candidate run ID and artifact digest.
5. Download the combined artifact.
6. Verify its attestation, `source-commit.txt`, `SHA256SUMS`, archive manifests,
   license inventory, prohibited-file exclusions, and smoke-test evidence.
7. Record the unsigned-Windows disclosure for the release notes.

Do not continue if the artifact has expired, any platform failed, or any value
does not match the exact `main` SHA. Fix the problem through a new pull request
and build a new candidate for the new commit.

### Approve and tag

1. Open **Actions → Approve Release → Run workflow**.
2. Select branch `main`.
3. Enter the canonical version, exact candidate commit, candidate run ID, and
   exact artifact digest.
4. Check the license, native smoke-test, unsigned-Windows, and final-release
   acknowledgement boxes.
5. Type the exact `authorization_phrase` shown by the workflow, including the
   version, commit, run ID, and digest copied from the candidate run.
6. Run the workflow and review its unprivileged preflight summary.
7. Watch the environment-scoped tag job repeat the mutable external-state
   checks before it mints the App token.
8. Confirm the job reports the annotated tag's read-back verification and the
   downstream Publish Release run URL.

Never create a parallel tag manually after approval has begun.

### Publish and verify

1. Open the linked **Publish Release** run.
2. Confirm it is running at `refs/tags/v<version>`, not `main`.
3. Confirm candidate assembly and checksum verification pass.
4. Confirm all four npm packages publish or are safely verified and skipped.
5. Confirm the GitHub Release remains a draft until npm succeeds and every
   release-asset digest is verified.
6. Confirm the release publishes and displays GitHub's immutable indicator.
7. Verify each npm package's exact version and provenance. Confirm `latest`
   points to the new stable version, `beta` remains on historical `0.1.0`, and
   `bootstrap` remains on the inert placeholder.
8. Confirm GitHub identifies the release as non-prerelease and latest, then
   verify the public archives against `SHA256SUMS` and the release attestation.
9. For the first stable release only, update the public site, installers, and
   installation docs from explicit `@beta` references to unqualified stable
   installs after npm `latest` is verified. Do not merge that launch update
   before `latest` points to the stable version.

## Recovery and rollback

### Before tag creation

A failed prepare, candidate, preflight, or tag job before reference creation has
not released anything. Fix the repository through a new pull request, build a
new exact-main candidate, and submit a new approval run. Do not authorize stale
candidate runs.

### Tag exists but publication is incomplete

Do not run Prepare Release or Approve Release again for that version. Open
**Actions → Publish Release → Run workflow**, choose the existing `v<version>`
tag as the ref, and provide the exact values recorded in the annotated tag.

The publisher must be idempotent:

- already-published npm versions are skipped only after exact-byte and
  provenance verification;
- a partial npm publication resumes in dependency order;
- an existing draft release is reused only when every existing asset is
  byte-identical; and
- a published immutable release is treated as final.

If npm accepted a package but its metadata has not propagated, wait for the
registry record to become visible and rerun the same tag. Do not republish under
a different tarball and do not move the tag.

If the approval workflow created the tag but failed before dispatching the
publisher, manually dispatch **Publish Release** at that exact tag. If it
created only an unreachable tag object but no tag reference, a new approval run
may retry after confirming the reference is absent; unreachable Git objects do
not authorize publication.

### Published release defect

There is no rollback that mutates a published `v*` tag or its immutable assets.
Fix the defect on `main` and release a new patch version. If a security or
packaging incident requires user communication, update advisories and package
deprecation guidance without replacing released bytes.

### Incorrect production tag created before publication

Do not publish it. Because production update/deletion protection is fail-closed,
record the incident and prepare a new version. Never weaken the production
ruleset to recycle the name.

### Credential incident

If the App private key may be exposed:

1. cancel any in-progress tag job before it mints or uses an App token;
2. remove the App from the creation-ruleset bypass list;
3. revoke the compromised private key and generate a replacement;
4. inspect ruleset history, Actions runs, Git references, and audit/security
   logs; and
5. restore the environment secret only after the incident review is complete.

The mutation ruleset continues protecting existing release tags while the App
is disabled.

## Test-prefix exercise

The initial exercise passed in
[run 29254385483](https://github.com/volt-hq/Volt/actions/runs/29254385483).
Repeat this exercise after changing the App identity, private key handling,
environment policy, tag rulesets, or tag-creation workflow. Do not create a
disposable `v*` tag.

1. Create temporary tag rulesets for `release-automation-test/*`:
   - creation restriction with `Volt Release Tagger` as the only automation
     bypass actor;
   - update and deletion restrictions without the App as a bypass actor;
   - owner-only deletion bypass for cleanup of test tags.
2. Configure a test workflow that uses the `release-authorization`
   environment but creates only an annotated
   `release-automation-test/<timestamp>` tag at a harmless `main` commit.
3. Verify the App can create the annotated test tag only from an owner-triggered
   run with the exact authorization phrase and all acknowledgement booleans.
4. Using the App token, verify update and deletion attempts are rejected.
5. Verify an ordinary `GITHUB_TOKEN` with `contents: write` cannot create a tag
   covered by the test creation ruleset.
6. Verify the owner can remove the disposable test tag through the temporary
   cleanup bypass.
7. Delete the temporary test rulesets and workflow, then review their history.
8. Only after these checks pass, activate the production `v*` rulesets and
   release workflows.

The production mutation ruleset must never gain the test cleanup bypass as an
automation path.

## Credential-free alternative

The dedicated App avoids a long-lived personal access token, but its PEM
private key is a long-lived credential isolated by the
`release-authorization` environment and its `main` ref policy.
If policy changes to prohibit every long-lived credential, not just PATs, a
workflow cannot automatically act as the owner-only tag creator with the
documented GitHub primitives. The owner must create the exact tag through a
GitHub-authenticated manual action, and the annotated tag evidence must either
be preserved by that action or replaced with an explicitly approved, attested
release record. Do not grant the general GitHub Actions App broad `v*` bypass
access as a shortcut.
