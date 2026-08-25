import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectBinaryLicenses } from "./collect-binary-licenses.mjs";
import {
	assertPublishedPackageMatchesRelease,
	NPM_PROVENANCE_PREDICATE_TYPE,
	NPM_PUBLISHED_METADATA_FIELDS,
	verifyPublishedPackageAfterPublish,
} from "./npm-publish-verification.mjs";
import {
	BOOTSTRAP_VERSION,
	INITIAL_BETA_VERSION,
	npmViewPackageMetadata,
	parseBootstrapVerificationArgs,
	verifyPreflightPackageMetadata,
	verifyTagWorkflowPackageMetadata,
} from "./verify-npm-package-bootstrap.mjs";
import {
	assertCandidateArtifactDigest,
	assertCandidateMatchesHead,
	assertCandidateRunId,
	assertCandidateWorkflowArtifact,
	assertCandidateWorkflowRun,
	assertReleaseTagMatchesCandidate,
	candidateTagAttestation,
	createReleaseAuthorization,
	formatGitHubOutputs,
	parseReleaseInvocation,
} from "./release-phase.mjs";
import { assertReleaseTagAvailable, getPlannedReleaseVersion, planReleaseTarget } from "./release-target.mjs";
import {
	RELEASE_CHANGELOG,
	RELEASE_PACKAGE_IDENTITIES,
	RELEASE_PACKAGES,
	verifyReleaseGitProvenance,
	verifyReleasePackageMetadata,
	versionFromReleaseTag,
} from "./verify-release-provenance.mjs";

/**
 * Repository-scoping variables git exports to hook processes.
 *
 * Deliberately not every GIT_* name: GIT_EXEC_PATH and friends tell git where
 * its own helpers live, and dropping those breaks git outright. Only the ones
 * that redirect a command at a different repository belong here.
 */
const GIT_REPO_SCOPING_ENV = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_INDEX_VERSION",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_WORK_TREE",
];

function scrubGitRepoScopingEnv(env) {
	for (const name of GIT_REPO_SCOPING_ENV) delete env[name];
	return env;
}

/**
 * This suite builds throwaway git repositories and shells out to `git` against
 * them. Run from a git hook — which is exactly what the pre-commit `npm run
 * check` does — those commands inherit GIT_DIR and GIT_INDEX_FILE from the
 * commit in progress, so each one silently retargets the developer's real
 * repository instead of the fixture.
 *
 * Committing from a worktree makes that destructive. GIT_DIR is then
 * `.git/worktrees/<name>`, whose config writes delegate to the shared
 * `.git/config`, and a fixture `git init` against it infers a bare repository
 * and writes `core.bare = true` there. Every checkout backed by that config —
 * including the developer's main one — starts failing with "this operation must
 * be run in a work tree" until the value is hand-repaired.
 *
 * Scrub once, before any fixture runs, so every child process started from here
 * (git, npm, and the node command fixtures) begins from a clean slate.
 */
scrubGitRepoScopingEnv(process.env);

const isWindows = process.platform === "win32";

function prependPath(...directories) {
	return [...directories, process.env.PATH].filter(Boolean).join(delimiter);
}

function writeNodeCommand(directory, name, source) {
	if (isWindows) {
		const script = join(directory, `${name}.cjs`);
		const command = join(directory, `${name}.cmd`);
		writeFileSync(script, source);
		writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
		return command;
	}

	const command = join(directory, name);
	writeFileSync(command, `#!/usr/bin/env node\n${source}`);
	chmodSync(command, 0o755);
	return command;
}

function execNpm(args, options) {
	const commandOptions = {
		...options,
		env: {
			...process.env,
			...options?.env,
			npm_config_loglevel: "error",
			npm_config_update_notifier: "false",
		},
	};
	if (isWindows) {
		const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		return execFileSync(process.execPath, [npmCli, ...args], commandOptions);
	}
	return execFileSync("npm", args, commandOptions);
}

function resolvePythonCommand() {
	const override = process.env.VOLT_PYTHON;
	const candidates = override
		? [{ command: override, args: [] }]
		: isWindows
			? [
					{ command: "py", args: ["-3"] },
					{ command: "python", args: [] },
				]
			: [
					{ command: "python3", args: [] },
					{ command: "python", args: [] },
				];

	for (const candidate of candidates) {
		const result = spawnSync(candidate.command, [
			...candidate.args,
			"-c",
			"import sys; raise SystemExit(sys.version_info.major != 3)",
		]);
		if (result.status === 0) return candidate;
	}

	throw new Error(
		override
			? `VOLT_PYTHON does not name a working Python 3 interpreter: ${override}`
			: "Python 3 is required; set VOLT_PYTHON to an interpreter path if it is not discoverable",
	);
}

const pythonCommand = resolvePythonCommand();

function execPython(args, options) {
	return execFileSync(pythonCommand.command, [...pythonCommand.args, ...args], options);
}

function spawnPython(args, options) {
	return spawnSync(pythonCommand.command, [...pythonCommand.args, ...args], options);
}

function resolveGitForWindowsShell(name) {
	const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
	const shell = resolve(gitExecPath, "..", "..", "..", "bin", name);
	if (!existsSync(shell)) {
		throw new Error(`Git for Windows shell was not found at ${shell}`);
	}
	return shell;
}

function resolvePosixShell() {
	if (process.env.VOLT_POSIX_SHELL) return process.env.VOLT_POSIX_SHELL;
	return isWindows ? resolveGitForWindowsShell("sh.exe") : "sh";
}

function resolveBashShell() {
	if (process.env.VOLT_BASH) return process.env.VOLT_BASH;
	return isWindows ? resolveGitForWindowsShell("bash.exe") : "bash";
}

const posixShell = resolvePosixShell();
const bashShell = resolveBashShell();

test("release tags are canonical semver tags", () => {
	assert.equal(versionFromReleaseTag("v0.1.0"), "0.1.0");
	for (const invalid of ["0.1.0", "v00.1.0", "v0.1", "main", "v0.1.0-rc.1", "v0.1.0\nmain"]) {
		assert.throws(() => versionFromReleaseTag(invalid));
	}
});

test("initial release can prepare the current version without changing normal release targets", () => {
	assert.deepEqual(planReleaseTarget("0.1.0", "0.1.0"), { type: "current", value: "0.1.0" });
	assert.deepEqual(planReleaseTarget("0.1.1", "0.1.0"), { type: "set", value: "0.1.1" });
	assert.deepEqual(planReleaseTarget("patch", "0.1.0"), { type: "bump", value: "patch" });
	assert.equal(getPlannedReleaseVersion("patch", "0.1.0"), "0.1.1");
	assert.equal(getPlannedReleaseVersion("minor", "0.1.9"), "0.2.0");
	assert.equal(getPlannedReleaseVersion("major", "9.8.7"), "10.0.0");
	assert.throws(() => planReleaseTarget("0.0.9", "0.1.0"), /must not be lower/);
	assert.throws(() => planReleaseTarget("0.2.0", "0.2.0"), /one-time 0\.1\.0 bootstrap/);
	assert.throws(() => planReleaseTarget("00.1.0", "0.1.0"), /Invalid release target/);

	const available = (_command, args) => ({ status: args[0] === "show-ref" ? 1 : 2 });
	assert.doesNotThrow(() => assertReleaseTagAvailable("0.1.0", available));
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", (_command, args) => ({ status: args[0] === "show-ref" ? 0 : 2 })),
		/already exists locally.*Refusing to rerun/s,
	);
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", (_command, args) => ({ status: args[0] === "show-ref" ? 1 : 0 })),
		/already exists on origin.*Refusing to rerun/s,
	);
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", () => ({ status: 128, stderr: "network unavailable" })),
		/network unavailable/,
	);

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	const prepareFlow = releaseScript.slice(
		releaseScript.indexOf("function prepareReleaseCommit"),
		releaseScript.indexOf("function printPreparedReleaseNextSteps"),
	);
	assert.ok(prepareFlow.indexOf("verifyNpmVersionAvailable(plannedVersion") < prepareFlow.indexOf("bumpOrSetVersion(target)"));
	assert.doesNotMatch(prepareFlow, /git tag/);
});

test("release finalization requires explicit sign-off for the exact prepared candidate", () => {
	const commit = "a".repeat(40);
	assert.deepEqual(parseReleaseInvocation(["prepare", "patch"]), { phase: "prepare", target: "patch" });
	assert.deepEqual(parseReleaseInvocation(["prepare", "0.1.0"]), { phase: "prepare", target: "0.1.0" });
	assert.deepEqual(parseReleaseInvocation(["prepare-pr", "patch"]), { phase: "prepare-pr", target: "patch" });
	assert.deepEqual(parseReleaseInvocation(["prepare-pr", "minor"]), { phase: "prepare-pr", target: "minor" });
	assert.deepEqual(parseReleaseInvocation(["finalize", commit]), { phase: "finalize", candidateCommit: commit });
	assert.deepEqual(parseReleaseInvocation(["authorize", commit]), { phase: "authorize", candidateCommit: commit });
	for (const invalid of [
		["patch"],
		["prepare"],
		["prepare", "patch", "extra"],
		["prepare-pr", "major"],
		["prepare-pr", "0.2.0"],
		["prepare-pr", "patch", "extra"],
		["authorize", "A".repeat(40)],
		["authorize", commit, "extra"],
		["finalize"],
		["finalize", "A".repeat(40)],
		["finalize", "a".repeat(39)],
		["finalize", commit, "extra"],
		["next-cycle", commit],
	]) {
		assert.throws(() => parseReleaseInvocation(invalid), /Usage:/);
	}
	assert.equal(assertCandidateMatchesHead(commit, commit), commit);
	assert.throws(() => assertCandidateMatchesHead(commit, "b".repeat(40)), /does not match current HEAD/);
	assert.equal(assertCandidateRunId("123456789"), "123456789");
	for (const invalidRunId of [undefined, "", "0", "01", "-1", "1.5", "abc", "1\n2"]) {
		assert.throws(() => assertCandidateRunId(invalidRunId), /VOLT_APPROVED_CANDIDATE_RUN_ID/);
	}
	const artifactDigest = `sha256:${"c".repeat(64)}`;
	assert.equal(assertCandidateArtifactDigest(artifactDigest), artifactDigest);
	for (const invalidDigest of [undefined, "", "c".repeat(64), `sha256:${"C".repeat(64)}`, `sha256:${"c".repeat(63)}`]) {
		assert.throws(() => assertCandidateArtifactDigest(invalidDigest), /VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST/);
	}
	const workflowRun = {
		id: 123456789,
		repository: { full_name: "volt-hq/Volt" },
		path: ".github/workflows/build-standalone-candidate.yml",
		event: "workflow_dispatch",
		head_branch: "main",
		head_sha: commit,
		status: "completed",
		conclusion: "success",
	};
	assert.equal(assertCandidateWorkflowRun(workflowRun, { candidateCommit: commit, runId: "123456789" }), workflowRun);
	for (const override of [
		{ id: 987654321 },
		{ repository: { full_name: "someone/fork" } },
		{ path: ".github/workflows/other.yml" },
		{ event: "push" },
		{ head_branch: "feature" },
		{ head_sha: "b".repeat(40) },
		{ status: "in_progress", conclusion: null },
		{ conclusion: "failure" },
	]) {
		assert.throws(
			() => assertCandidateWorkflowRun({ ...workflowRun, ...override }, { candidateCommit: commit, runId: "123456789" }),
			/approved|workflow run/,
		);
	}
	const artifact = {
		id: 42,
		name: `standalone-candidate-${commit}`,
		digest: artifactDigest,
		expired: false,
		size_in_bytes: 1024,
		workflow_run: { id: 123456789 },
	};
	assert.equal(
		assertCandidateWorkflowArtifact(
			{ total_count: 1, artifacts: [artifact] },
			{ candidateCommit: commit, runId: "123456789", artifactDigest },
		),
		artifact,
	);
	for (const response of [
		{ total_count: 0, artifacts: [] },
		{ total_count: 1, artifacts: [{ ...artifact, expired: true }] },
		{ total_count: 1, artifacts: [{ ...artifact, size_in_bytes: 0 }] },
		{ total_count: 1, artifacts: [{ ...artifact, workflow_run: undefined }] },
		{ total_count: 1, artifacts: [{ ...artifact, workflow_run: { id: 987654321 } }] },
		{ total_count: 2, artifacts: [artifact, { ...artifact, id: 43 }] },
	]) {
		assert.throws(
			() => assertCandidateWorkflowArtifact(response, { candidateCommit: commit, runId: "123456789" }),
			/artifact|workflow run/,
		);
	}
	assert.throws(
		() =>
			assertCandidateWorkflowArtifact(
				{ total_count: 1, artifacts: [artifact] },
				{ candidateCommit: commit, runId: "123456789", artifactDigest: `sha256:${"d".repeat(64)}` },
			),
		/not explicitly approved digest/,
	);

	const tagAttestation = candidateTagAttestation(commit, "123456789", artifactDigest);
	assert.equal(
		tagAttestation,
		`Standalone-Candidate-Commit: ${commit}\nStandalone-Candidate-Run: 123456789\nStandalone-Candidate-Artifact-Digest: ${artifactDigest}`,
	);
	assert.equal(
		candidateTagAttestation(commit, "123456789"),
		`Standalone-Candidate-Commit: ${commit}\nStandalone-Candidate-Run: 123456789`,
	);
	const authorization = createReleaseAuthorization({
		tag: "v0.2.0",
		version: "0.2.0",
		candidateCommit: commit,
		candidateRunId: "123456789",
		candidateArtifactDigest: artifactDigest,
	});
	assert.deepEqual(authorization, {
		tag: "v0.2.0",
		version: "0.2.0",
		"candidate-commit": commit,
		"candidate-run-id": "123456789",
		"candidate-artifact-digest": artifactDigest,
		"tag-message-base64": Buffer.from(`Release v0.2.0\n\n${tagAttestation}`, "utf8").toString("base64"),
	});
	assert.equal(
		Buffer.from(authorization["tag-message-base64"], "base64").toString("utf8"),
		`Release v0.2.0\n\n${tagAttestation}`,
	);
	assert.equal(
		formatGitHubOutputs(authorization),
		Object.entries(authorization)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n") + "\n",
	);
	assert.equal(
		formatGitHubOutputs({ message: "first\nsecond" }),
		"message<<VOLT_MESSAGE_EOF\nfirst\nsecond\nVOLT_MESSAGE_EOF\n",
	);
	const localTagMessage = `Release v0.2.0\n\nStandalone-Candidate-Commit: ${commit}\nStandalone-Candidate-Run: 123456789\n`;
	assert.deepEqual(
		assertReleaseTagMatchesCandidate({
			tag: "v0.2.0",
			candidateCommit: commit,
			tagType: "tag",
			taggedCommit: commit,
			tagMessage: localTagMessage,
		}),
		{ candidateArtifactDigest: undefined, candidateRunId: "123456789" },
	);
	assert.deepEqual(
		assertReleaseTagMatchesCandidate({
			tag: "v0.2.0",
			candidateCommit: commit,
			tagType: "tag",
			taggedCommit: commit,
			tagMessage: `Release v0.2.0\n\n${tagAttestation}\n`,
		}),
		{ candidateArtifactDigest: artifactDigest, candidateRunId: "123456789" },
	);
	for (const invalidTag of [
		{ tagType: "commit" },
		{ taggedCommit: "b".repeat(40) },
		{ tagMessage: `Release v0.2.0\n\nStandalone-Candidate-Commit: ${commit}\n` },
		{ tagMessage: `${localTagMessage}Standalone-Candidate-Commit: ${commit}\n` },
	]) {
		assert.throws(
			() =>
				assertReleaseTagMatchesCandidate({
					tag: "v0.2.0",
					candidateCommit: commit,
					tagType: "tag",
					taggedCommit: commit,
					tagMessage: localTagMessage,
					...invalidTag,
				}),
			/annotated|points to|attestation/,
		);
	}

	const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(packageManifest.scripts["release:initial"], "node scripts/release.mjs prepare 0.1.0");
	assert.equal(packageManifest.scripts["release:patch"], "node scripts/release.mjs prepare patch");
	assert.equal(packageManifest.scripts["release:minor"], "node scripts/release.mjs prepare minor");
	assert.equal(packageManifest.scripts["release:major"], "node scripts/release.mjs prepare major");
	assert.equal(packageManifest.scripts["release:finalize"], "node scripts/release.mjs finalize");
	assert.equal(packageManifest.scripts["release:prepare-pr"], "node scripts/release.mjs prepare-pr");
	assert.equal(packageManifest.scripts["release:authorize"], "node scripts/release.mjs authorize");
	assert.equal(packageManifest.scripts["release:next-cycle"], undefined);

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	const prepareFlow = releaseScript.slice(
		releaseScript.indexOf("function prepareReleaseCommit"),
		releaseScript.indexOf("function printPreparedReleaseNextSteps"),
	);
	const preparePrFlow = releaseScript.slice(
		releaseScript.indexOf("function preparePrRelease"),
		releaseScript.indexOf("function verifyReleaseAuthorization"),
	);
	const localPrepareFlow = releaseScript.slice(
		releaseScript.indexOf("function prepareRelease(target)"),
		releaseScript.indexOf("function preparePrRelease"),
	);
	const authorizeFlow = releaseScript.slice(
		releaseScript.indexOf("function authorizeRelease"),
		releaseScript.indexOf("function finalizeRelease"),
	);
	const finalizeFlow = releaseScript.slice(releaseScript.indexOf("function finalizeRelease"), releaseScript.indexOf("console.log(`\\n=== Release"));
	assert.doesNotMatch(prepareFlow, /git tag|git push origin \$\{tag\}/);
	assert.doesNotMatch(prepareFlow, /git push/);
	assert.ok(prepareFlow.indexOf("readReleaseChangesets()") < prepareFlow.indexOf("bumpOrSetVersion(target)"));
	assert.match(prepareFlow, /assertReleaseTargetSatisfiesChangesets\(currentVersion, plannedVersion, changesets\)/);
	assert.match(prepareFlow, /applyReleaseSection\(/);
	assert.doesNotMatch(preparePrFlow, /git push|git tag/);
	assert.match(preparePrFlow, /prepareReleaseCommit\(target, \{ requireMainBranch: false \}\)/);
	assert.doesNotMatch(authorizeFlow, /git tag|git push|git commit|applyReleaseSection/);
	assert.match(authorizeFlow, /requireDigest: true/);
	assert.match(authorizeFlow, /verifyReleaseAuthorization/);
	assert.match(authorizeFlow, /createReleaseAuthorization/);
	assert.match(authorizeFlow, /writeGitHubOutputs/);
	assert.match(localPrepareFlow, /git push origin main/);
	assert.ok(finalizeFlow.indexOf("verifyReleaseAuthorization(candidateCommit") < finalizeFlow.indexOf("git tag -a -m"));
	assert.match(releaseScript, /assertCandidateRunId\(process\.env\.VOLT_APPROVED_CANDIDATE_RUN_ID\)/);
	assert.match(releaseScript, /verifyReleasePackageMetadata\(tag\)/);
	assert.match(releaseScript, /verifyApprovedCandidateRun\(candidateCommit, candidateRunId, candidateArtifactDigest\)/);
	assert.match(finalizeFlow, /candidateTagAttestation\(candidateCommit, candidateRunId, candidateArtifactDigest\)/);
	assert.match(finalizeFlow, /git tag -a -m .* -m .* \$\{tag\} \$\{candidateCommit\}/s);
	assert.match(finalizeFlow, /git push origin \$\{tag\}/);
	assert.doesNotMatch(finalizeFlow, /git push origin main|applyReleaseSection/);
	assert.doesNotMatch(releaseScript, /nextCycle|next-cycle|addUnreleasedSection|\[Unreleased\]/);
	const authorizationChecks = releaseScript.slice(
		releaseScript.indexOf("function verifyReleaseAuthorization"),
		releaseScript.indexOf("function approvedCandidateEnvironment"),
	);
	assert.match(authorizationChecks, /assertNoPendingChangesets\(\)/);
});

test("GitHub-native release phases preserve their mutation boundaries end to end", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-github-release-phases-"));
	const repository = join(directory, "repository");
	const origin = join(directory, "origin.git");
	const fakeBin = join(directory, "bin");
	const releaseScript = join(process.cwd(), "scripts", "release.mjs");
	const git = (args, cwd = repository) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const packageIdentities = [
		["ai", "@hansjm10/volt-ai"],
		["tui", "@hansjm10/volt-tui"],
		["agent", "@hansjm10/volt-agent-core"],
		["coding-agent", "@hansjm10/volt-coding-agent"],
	];

	try {
		mkdirSync(repository, { recursive: true });
		mkdirSync(fakeBin, { recursive: true });
		execFileSync("git", ["init", "--bare", origin], {
			cwd: directory,
			stdio: ["ignore", "ignore", "pipe"],
		});
		git(["init"]);
		git(["checkout", "-b", "main"]);
		git(["config", "user.name", "Volt Release Test"]);
		git(["config", "user.email", "release-test@example.invalid"]);

		writeFileSync(join(repository, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
		mkdirSync(join(repository, "scripts"), { recursive: true });
		writeFileSync(join(repository, "scripts", "verify-npm-package-bootstrap.mjs"), "// fixture no-op\n");
		for (const [packageDirectory, name] of packageIdentities) {
			const path = join(repository, "packages", packageDirectory);
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "package.json"),
				`${JSON.stringify(
					{
						name,
						version: "0.1.0",
						repository: {
							type: "git",
							url: "git+https://github.com/volt-hq/Volt.git",
							directory: `packages/${packageDirectory}`,
						},
					},
					null,
					2,
				)}\n`,
			);
		}
		writeFileSync(join(repository, "packages", "coding-agent", "CHANGELOG.md"), "# Changelog\n\n## [0.1.0] - 2026-07-13\n\nInitial release.\n");
		mkdirSync(join(repository, ".changeset"), { recursive: true });
		writeFileSync(join(repository, ".changeset", "README.md"), "# Changesets fixture\n");
		writeFileSync(
			join(repository, ".changeset", "fixture-fix.md"),
			'---\n"@hansjm10/volt-coding-agent": patch\n---\n\nfix(daemon): Fixed a fixture defect.\n',
		);

		writeNodeCommand(
			fakeBin,
			"npm",
			`
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "version:patch") {
	for (const directory of ["ai", "tui", "agent", "coding-agent"]) {
		const path = "packages/" + directory + "/package.json";
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.version = "0.1.1";
		writeFileSync(path, JSON.stringify(manifest, null, 2) + "\\n");
	}
}
`,
		);

		writeNodeCommand(
			fakeBin,
			"gh",
			`
const runId = process.env.VOLT_APPROVED_CANDIDATE_RUN_ID;
const commit = process.env.VOLT_TEST_CANDIDATE_COMMIT;
const digest = process.env.VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST;
if (process.argv.join(" ").includes("/artifacts?")) {
	console.log(JSON.stringify({
		total_count: 1,
		artifacts: [{
			id: 42,
			name: "standalone-candidate-" + commit,
			digest,
			expired: false,
			size_in_bytes: 1024,
			workflow_run: { id: Number(runId) }
		}]
	}));
} else {
	console.log(JSON.stringify({
		id: Number(runId),
		repository: { full_name: "volt-hq/Volt" },
		path: ".github/workflows/build-standalone-candidate.yml",
		event: "workflow_dispatch",
		head_branch: "main",
		head_sha: commit,
		status: "completed",
		conclusion: "success"
	}));
}
`,
		);

		git(["add", "."]);
		git(["commit", "-m", "Initial release fixture"]);
		git(["remote", "add", "origin", origin]);
		git(["push", "-u", "origin", "main"]);
		const initialCommit = git(["rev-parse", "HEAD"]);
		git(["checkout", "-b", "release/v0.1.1"]);

		const releaseEnvironment = {
			...process.env,
			PATH: prependPath(fakeBin),
		};
		const preparedOutput = execFileSync(process.execPath, [releaseScript, "prepare-pr", "patch"], {
			cwd: repository,
			encoding: "utf8",
			env: releaseEnvironment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const candidateCommit = git(["rev-parse", "HEAD"]);
		assert.notEqual(candidateCommit, initialCommit);
		assert.equal(git(["log", "-1", "--format=%s"]), "Release v0.1.1");
		assert.equal(git(["rev-parse", "refs/remotes/origin/main"]), initialCommit);
		assert.equal(git(["tag", "--list"]), "");
		assert.equal(git(["status", "--porcelain"]), "");
		const preparedChangelog = readFileSync(join(repository, "packages", "coding-agent", "CHANGELOG.md"), "utf8");
		assert.match(preparedChangelog, /^# Changelog\n\n## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}\n\n### Fixes\n\n- \*\*daemon:\*\* Fixed a fixture defect\.\n\n## \[0\.1\.0\]/);
		assert.equal(existsSync(join(repository, ".changeset", "fixture-fix.md")), false);
		assert.equal(readFileSync(join(repository, ".changeset", "README.md"), "utf8"), "# Changesets fixture\n");
		assert.match(preparedOutput, /resulting exact main SHA/);
		assert.match(preparedOutput, /post-merge main SHA/);
		assert.doesNotMatch(preparedOutput, new RegExp(`Build Standalone Candidate workflow with commit ${candidateCommit}`));

		git(["checkout", "main"]);
		git(["merge", "--ff-only", "release/v0.1.1"]);
		git(["push", "origin", "main"]);
		assert.equal(git(["rev-parse", "refs/remotes/origin/main"]), candidateCommit);

		const candidateRunId = "123456789";
		const candidateArtifactDigest = `sha256:${"c".repeat(64)}`;
		const authorizationOutput = join(directory, "authorize-output");
		writeFileSync(authorizationOutput, "");
		const authorizedEnvironment = {
			...releaseEnvironment,
			GITHUB_OUTPUT: authorizationOutput,
			VOLT_APPROVED_CANDIDATE_RUN_ID: candidateRunId,
			VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST: candidateArtifactDigest,
			VOLT_TEST_CANDIDATE_COMMIT: candidateCommit,
		};
		const missingDigestEnvironment = { ...authorizedEnvironment };
		delete missingDigestEnvironment.VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST;
		const missingDigest = spawnSync(process.execPath, [releaseScript, "authorize", candidateCommit], {
			cwd: repository,
			encoding: "utf8",
			env: missingDigestEnvironment,
		});
		assert.notEqual(missingDigest.status, 0);
		assert.match(missingDigest.stderr, /VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST/);
		assert.equal(readFileSync(authorizationOutput, "utf8"), "");

		const refsBeforeAuthorization = git(["show-ref"]);
		const changelogBeforeAuthorization = readFileSync(join(repository, "packages", "coding-agent", "CHANGELOG.md"), "utf8");
		execFileSync(process.execPath, [releaseScript, "authorize", candidateCommit], {
			cwd: repository,
			encoding: "utf8",
			env: authorizedEnvironment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const authorization = createReleaseAuthorization({
			tag: "v0.1.1",
			version: "0.1.1",
			candidateCommit,
			candidateRunId,
			candidateArtifactDigest,
		});
		assert.equal(readFileSync(authorizationOutput, "utf8"), formatGitHubOutputs(authorization));
		assert.equal(git(["rev-parse", "HEAD"]), candidateCommit);
		assert.equal(git(["show-ref"]), refsBeforeAuthorization);
		assert.equal(git(["status", "--porcelain"]), "");
		assert.equal(
			readFileSync(join(repository, "packages", "coding-agent", "CHANGELOG.md"), "utf8"),
			changelogBeforeAuthorization,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("npm bootstrap verification reserves names without publishing the real initial version", () => {
	assert.equal(BOOTSTRAP_VERSION, "0.0.0-bootstrap.0");
	assert.equal(INITIAL_BETA_VERSION, "0.1.0");
	assert.deepEqual(parseBootstrapVerificationArgs(["preflight", "--version", "0.1.0", "--initial"]), {
		initial: true,
		mode: "preflight",
		version: "0.1.0",
	});
	assert.deepEqual(parseBootstrapVerificationArgs(["tag", "--version", "0.1.0"]), {
		initial: false,
		mode: "tag",
		version: "0.1.0",
	});
	assert.throws(
		() => parseBootstrapVerificationArgs(["tag", "--version", "0.1.0", "--initial"]),
		/only valid for the preflight/,
	);

	const name = "@hansjm10/volt-ai";
	const placeholder = {
		name,
		versions: [BOOTSTRAP_VERSION],
		"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
	};
	assert.doesNotThrow(() => verifyPreflightPackageMetadata(name, "0.1.0", placeholder, { initial: true }));
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, versions: [BOOTSTRAP_VERSION, "0.1.0"] },
				{ initial: true },
			),
		/already published/,
	);
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, versions: [BOOTSTRAP_VERSION, "0.0.1"] },
				{ initial: true },
			),
		/only placeholder version/,
	);
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, "dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: "0.1.0" } },
				{ initial: true },
			),
		/npm-required latest/,
	);

	let queriedArgs;
	const queried = npmViewPackageMetadata(name, (_command, args) => {
		queriedArgs = args;
		return { status: 0, stdout: JSON.stringify(placeholder), stderr: "" };
	});
	assert.deepEqual(queried, placeholder);
	assert.ok(queriedArgs.includes(`${name}@${BOOTSTRAP_VERSION}`));
	assert.doesNotThrow(() =>
		verifyPreflightPackageMetadata(name, "0.1.1", {
			name,
			versions: [BOOTSTRAP_VERSION, "0.1.0"],
			"dist-tags": { beta: "0.1.0", bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
		}),
	);
});

test("tag workflow verification supports the historical beta and idempotent stable publication", () => {
	const name = "@hansjm10/volt-ai";
	assert.doesNotThrow(() =>
		verifyTagWorkflowPackageMetadata(name, "0.1.0", {
			name,
			versions: [BOOTSTRAP_VERSION],
			"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
		}),
	);
	assert.throws(
		() =>
			verifyTagWorkflowPackageMetadata(name, "0.1.0", {
				name,
				versions: [BOOTSTRAP_VERSION, "0.0.1"],
				"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
			}),
		/only placeholder version/,
	);
	const initialBeta = {
		name,
		versions: [BOOTSTRAP_VERSION, INITIAL_BETA_VERSION],
		"dist-tags": { beta: INITIAL_BETA_VERSION, bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
	};
	assert.doesNotThrow(() => verifyTagWorkflowPackageMetadata(name, INITIAL_BETA_VERSION, initialBeta));
	assert.doesNotThrow(() => verifyTagWorkflowPackageMetadata(name, "0.2.0", initialBeta));
	assert.doesNotThrow(() =>
		verifyTagWorkflowPackageMetadata(name, "0.2.0", {
			...initialBeta,
			versions: [...initialBeta.versions, "0.2.0"],
			"dist-tags": { ...initialBeta["dist-tags"], latest: "0.2.0" },
		}),
	);
	assert.throws(
		() =>
			verifyTagWorkflowPackageMetadata(name, "0.2.0", {
				...initialBeta,
				versions: [...initialBeta.versions, "0.2.0"],
			}),
		/latest does not point to it/,
	);
	assert.throws(
		() =>
			verifyTagWorkflowPackageMetadata(name, "0.2.0", {
				...initialBeta,
				"dist-tags": { ...initialBeta["dist-tags"], beta: BOOTSTRAP_VERSION },
			}),
		/preserve the historical beta/,
	);
});

test("release package versions and the product changelog must match the tag", () => {
	const files = new Map();
	for (const { directory, name } of RELEASE_PACKAGE_IDENTITIES) {
		files.set(
			`${directory}/package.json`,
			JSON.stringify({
				name,
				version: "1.2.3",
				repository: { url: "git+https://github.com/volt-hq/Volt.git", directory },
			}),
		);
	}
	files.set(RELEASE_CHANGELOG, "# Changelog\n\n## [1.2.3] - 2026-07-12\n");
	assert.equal(verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), "1.2.3");
	assert.equal(RELEASE_CHANGELOG, "packages/coding-agent/CHANGELOG.md");
	files.set(RELEASE_CHANGELOG, "A link to ## [1.2.3] is not a release heading.\n");
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /no release section/);
	files.set(RELEASE_CHANGELOG, "# Changelog\n\n## [1.2.3] - 2026-07-12\n");
	files.set("packages/ai/package.json", JSON.stringify({ name: "@hansjm10/volt-ai", version: "1.2.4" }));
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /expected 1\.2\.3/);
	files.set("packages/ai/package.json", JSON.stringify({ name: "@earendil-works/volt-ai", version: "1.2.3" }));
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /expected @hansjm10\/volt-ai/);
});

test("npm policy requires the exact Iroh wrapper while quarantining third-party releases", () => {
	const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
	const codingAgentManifest = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
	assert.equal(rootManifest.packageManager, "npm@11.17.0");
	assert.deepEqual(rootManifest.devEngines?.packageManager, {
		name: "npm",
		version: "11.17.0",
		onFail: "error",
	});
	assert.deepEqual(readFileSync(".npmrc", "utf8").trim().split(/\r?\n/), [
		"save-exact=true",
		"min-release-age=2",
		"min-release-age-exclude[]=@hansjm10/volt-iroh*",
	]);
	assert.equal(codingAgentManifest.dependencies["@hansjm10/volt-iroh"], "1.1.1-volt.2");
	assert.equal(codingAgentManifest.optionalDependencies?.["@hansjm10/volt-iroh"], undefined);

	for (const [path, rootPath] of [
		["package-lock.json", "packages/coding-agent"],
		["packages/coding-agent/npm-shrinkwrap.json", ""],
	]) {
		const lock = JSON.parse(readFileSync(path, "utf8"));
		const root = lock.packages[rootPath];
		const wrapper = lock.packages["node_modules/@hansjm10/volt-iroh"];
		assert.equal(root.dependencies["@hansjm10/volt-iroh"], "1.1.1-volt.2", `${path} requires the wrapper`);
		assert.equal(root.optionalDependencies?.["@hansjm10/volt-iroh"], undefined, `${path} cannot omit the wrapper`);
		assert.equal(wrapper.version, "1.1.1-volt.2");
		assert.equal(wrapper.optional, undefined, `${path} marks the wrapper required`);
		assert.match(wrapper.integrity, /^sha512-/);
		assert.equal(
			lock.packages["node_modules/@hansjm10/volt-iroh-darwin-x64"],
			undefined,
			`${path} must not claim unsupported Darwin x64 phone transport`,
		);
		const bindings = Object.entries(lock.packages).filter(([entryPath]) =>
			/^node_modules\/@hansjm10\/volt-iroh-(?!$)/.test(entryPath),
		);
		assert.ok(bindings.length > 0, `${path} includes platform bindings`);
		for (const [entryPath, entry] of bindings) {
			assert.equal(entry.optional, true, `${path} keeps ${entryPath} optional`);
			assert.match(entry.integrity, /^sha512-/);
		}
	}

	for (const path of [
		".github/workflows/approve-release.yml",
		".github/workflows/build-binaries.yml",
		".github/workflows/build-standalone-candidate.yml",
		".github/workflows/ci.yml",
		".github/workflows/npm-audit.yml",
		".github/workflows/prepare-release.yml",
	]) {
		const workflow = readFileSync(path, "utf8");
		const npmPin = "npm install -g npm@11.17.0 --ignore-scripts";
		let installSearchFrom = 0;
		for (const match of workflow.matchAll(/npm ci\b/g)) {
			const precedingPin = workflow.lastIndexOf(npmPin, match.index);
			assert.ok(precedingPin >= installSearchFrom, `${path} installs npm 11.17.0 before each dependency resolution`);
			installSearchFrom = match.index + match[0].length;
		}
		const lines = workflow.split(/\r?\n/);
		for (const [lineIndex, line] of lines.entries()) {
			if (line.trim() !== npmPin) continue;
			let stepStart = lineIndex - 1;
			while (stepStart >= 0 && !lines[stepStart].trimStart().startsWith("- name:")) stepStart--;
			assert.ok(
				stepStart >= 0 &&
					lines.slice(stepStart, lineIndex).some((stepLine) => stepLine.trim() === "working-directory: ${{ runner.temp }}"),
				`${path} runs each npm bootstrap from runner.temp`,
			);
		}
		assert.doesNotMatch(workflow, /npm install -g npm@(?!11\.17\.0\b)/);
		assert.doesNotMatch(
			workflow,
			/^\s+cache: npm$/m,
			`${path} must not invoke the setup-node npm cache probe before installing pinned npm`,
		);
	}
	assert.doesNotMatch(readFileSync(".github/workflows/prepare-release.yml", "utf8"), /min_release_age|--min-release-age=0/);
});

test("shipped packages and standalone archives contain no development workflow tooling", () => {
	const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(rootManifest.private, true, "the monorepo root must never be publishable");

	const expectedFiles = {
		"packages/agent": ["dist", "README.md", "LICENSE"],
		"packages/ai": ["dist", "README.md", "LICENSE"],
		"packages/coding-agent": [
			"contract",
			"dist",
			"native/workspace-fs/prebuilds/manifest.json",
			"native/workspace-fs/prebuilds/darwin-arm64/workspace-fs.node",
			"native/workspace-fs/prebuilds/darwin-x64/workspace-fs.node",
			"native/workspace-fs/prebuilds/linux-arm64-gnu/workspace-fs.node",
			"native/workspace-fs/prebuilds/linux-arm64-musl/workspace-fs.node",
			"native/workspace-fs/prebuilds/linux-x64-gnu/workspace-fs.node",
			"native/workspace-fs/prebuilds/linux-x64-musl/workspace-fs.node",
			"native/workspace-fs/prebuilds/win32-arm64-msvc/workspace-fs.node",
			"native/workspace-fs/prebuilds/win32-x64-msvc/workspace-fs.node",
			"native/workspace-fs/licenses",
			"docs",
			"!docs/development.md",
			"!docs/*-design.md",
			"!docs/tla",
			"!docs/tla/**",
			"!docs/images/doom-extension.png",
			"examples",
			"!examples/README.binary.md",
			"!examples/extensions/doom-overlay",
			"!examples/extensions/doom-overlay/**",
			"!examples/**/node_modules",
			"!examples/**/node_modules/**",
			"containerization.md",
			"CHANGELOG.md",
			"LICENSE",
			"THIRD-PARTY-NOTICES.md",
			"BINARY-CAPABILITIES.md",
			"npm-shrinkwrap.json",
		],
		"packages/tui": [
			"dist/**/*",
			"native/win32/prebuilds/**/*.node",
			"native/darwin/prebuilds/**/*.node",
			"README.md",
			"LICENSE",
		],
	};
	const devToolingMarker = /\.changeset|\.volt|\.husky|\.github|scripts\//;
	for (const { directory } of RELEASE_PACKAGE_IDENTITIES) {
		const manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
		assert.deepEqual(
			manifest.files,
			expectedFiles[directory],
			`${directory} ships an unexpected file set; the changelog/changeset/release workflow is Volt-development tooling and stays repo-only — update this pin only for deliberate product packaging changes`,
		);
		for (const entry of manifest.files) {
			assert.doesNotMatch(entry, devToolingMarker, `${directory} files entry references development tooling: ${entry}`);
		}
	}

	const buildStandalone = readFileSync("scripts/build-standalone.mjs", "utf8");
	assert.match(
		buildStandalone,
		/"package\.json",\s*"README\.md",\s*"CHANGELOG\.md",\s*"LICENSE",\s*"THIRD-PARTY-NOTICES\.md",\s*"BINARY-CAPABILITIES\.md",\s*"npm-shrinkwrap\.json",\s*\]/,
		"the standalone archive's staged top-level file list changed; keep development tooling out and update this pin deliberately",
	);
	assert.doesNotMatch(buildStandalone, /\.changeset\/|\.volt\/|\.husky\//);
});

test("published docs are user-facing: docs.json navigation is the allowlist for the site and the npm package", () => {
	const docsDirectory = "packages/coding-agent/docs";
	const manifest = JSON.parse(readFileSync(`${docsDirectory}/docs.json`, "utf8"));
	const navPaths = manifest.navigation.flatMap((section) => section.items.map((item) => item.path));
	const navSet = new Set(navPaths);
	assert.equal(navPaths.length, navSet.size, "docs.json navigation lists a doc twice");

	const isDevelopmentDoc = (file) => file === "development.md" || file.endsWith("-design.md");
	for (const path of navPaths) {
		assert.ok(existsSync(`${docsDirectory}/${path}`), `docs.json navigation lists a missing doc: ${path}`);
		assert.ok(!isDevelopmentDoc(path), `${path} is development-facing and must not be published to the site or the npm package`);
	}
	for (const file of readdirSync(docsDirectory).filter((name) => name.endsWith(".md"))) {
		assert.ok(
			navSet.has(file) || isDevelopmentDoc(file),
			`docs/${file} has no audience: add it to docs.json navigation (user-facing, published) or name it *-design.md (development-facing, repo-only)`,
		);
	}

	const codingAgentManifest = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
	for (const exclusion of ["!docs/development.md", "!docs/*-design.md", "!docs/tla", "!docs/tla/**"]) {
		assert.ok(codingAgentManifest.files.includes(exclusion), `packages/coding-agent must exclude ${exclusion} from npm`);
	}

	const syncScript = readFileSync("site/scripts/sync-docs.mjs", "utf8");
	assert.match(
		syncScript,
		/manifest\.navigation\.flatMap/,
		"site/scripts/sync-docs.mjs must derive the published doc set from docs.json navigation, not the docs directory listing",
	);
});

test("release tooling publishes only the canonical Volt package identities under the latest dist-tag", () => {
	assert.deepEqual(RELEASE_PACKAGE_IDENTITIES, [
		{ directory: "packages/ai", name: "@hansjm10/volt-ai" },
		{ directory: "packages/tui", name: "@hansjm10/volt-tui" },
		{ directory: "packages/agent", name: "@hansjm10/volt-agent-core" },
		{ directory: "packages/coding-agent", name: "@hansjm10/volt-coding-agent" },
	]);
	const publishScript = readFileSync("scripts/publish.mjs", "utf8");
	const publishVerification = readFileSync("scripts/npm-publish-verification.mjs", "utf8");
	assert.match(publishScript, /const NPM_DIST_TAG = "latest";/);
	assert.match(publishScript, /"--tag", NPM_DIST_TAG/);
	assert.ok(publishScript.indexOf('run("npm", ["publish"') < publishScript.lastIndexOf("verifyPublishedPackageAfterPublish({"));
	assert.match(publishVerification, /DEFAULT_POST_PUBLISH_VERIFICATION_ATTEMPTS = 61/);
	assert.match(publishVerification, /DEFAULT_POST_PUBLISH_VERIFICATION_DELAY_MS = 5_000/);
	assert.doesNotMatch(publishScript, /@earendil-works\/volt-/);
	assert.doesNotMatch(publishScript, /@hansjm10\/volt-cli/);
});

test("idempotent npm publication requires exact release bytes and provenance", () => {
	assert.deepEqual(NPM_PUBLISHED_METADATA_FIELDS, ["name", "version", "gitHead", "repository", "dist-tags", "dist"]);
	const release = {
		name: "@hansjm10/volt-ai",
		version: "0.2.0",
		directory: "packages/ai",
		sourceCommit: "a".repeat(40),
		packed: { integrity: "sha512-release" },
		metadata: {
			name: "@hansjm10/volt-ai",
			version: "0.2.0",
			gitHead: "a".repeat(40),
			repository: {
				url: "git+https://github.com/volt-hq/Volt.git",
				directory: "packages/ai",
			},
			"dist-tags": { beta: "0.1.0", bootstrap: "0.0.0-bootstrap.0", latest: "0.2.0" },
			dist: {
				integrity: "sha512-release",
				attestations: {
					url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
					provenance: { predicateType: NPM_PROVENANCE_PREDICATE_TYPE },
				},
			},
		},
	};
	assert.doesNotThrow(() => assertPublishedPackageMatchesRelease(release));
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, dist: { ...release.metadata.dist, integrity: "sha512-other" } },
			}),
		/does not match/,
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, dist: { integrity: "sha512-release" } },
			}),
		/no valid npm provenance/,
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, gitHead: "b".repeat(40) },
			}),
		/published from git commit/,
	);
	assert.doesNotThrow(() =>
		assertPublishedPackageMatchesRelease({
			...release,
			metadata: { ...release.metadata, gitHead: undefined },
		}),
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: {
					...release.metadata,
					"dist-tags": { ...release.metadata["dist-tags"], latest: INITIAL_BETA_VERSION },
				},
			}),
		/latest dist-tag does not point to it/,
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: {
					...release.metadata,
					"dist-tags": { ...release.metadata["dist-tags"], beta: release.version },
				},
			}),
		/preserve the historical beta/,
	);

	const visibilityQueries = [];
	const sleeps = [];
	const logs = [];
	const published = verifyPublishedPackageAfterPublish(
		release,
		(name, version) => {
			visibilityQueries.push(`${name}@${version}`);
			return visibilityQueries.length === 1 ? undefined : release.metadata;
		},
		{
			attempts: 2,
			delayMs: 25,
			sleep: (milliseconds) => sleeps.push(milliseconds),
			log: (message) => logs.push(message),
		},
	);
	assert.equal(published, release.metadata);
	assert.deepEqual(visibilityQueries, ["@hansjm10/volt-ai@0.2.0", "@hansjm10/volt-ai@0.2.0"]);
	assert.deepEqual(sleeps, [25]);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /waiting for npm registry metadata/);

	let missingQueries = 0;
	assert.throws(
		() =>
			verifyPublishedPackageAfterPublish(
				release,
				() => {
					missingQueries += 1;
					return undefined;
				},
				{ attempts: 2, delayMs: 1, sleep: () => {}, log: () => {} },
			),
		/after 2 verification attempts/,
	);
	assert.equal(missingQueries, 2);

	let mismatchedQueries = 0;
	assert.throws(
		() =>
			verifyPublishedPackageAfterPublish(
				release,
				() => {
					mismatchedQueries += 1;
					return { ...release.metadata, dist: { ...release.metadata.dist, integrity: "sha512-other" } };
				},
				{ attempts: 2, delayMs: 1, sleep: () => {}, log: () => {} },
			),
		/does not match/,
	);
	assert.equal(mismatchedQueries, 1);
});

test("release git provenance requires an annotated tag reachable from origin/main", () => {
	const commit = "a".repeat(40);
	const successfulGit = (...args) => {
		const command = args.join(" ");
		if (command === "rev-parse HEAD" || command === "rev-parse refs/tags/v1.2.3^{commit}") return commit;
		if (command === "cat-file -t refs/tags/v1.2.3") return "tag";
		if (command === `merge-base --is-ancestor ${commit} refs/remotes/origin/main`) return "";
		throw new Error(`unexpected git command: ${command}`);
	};
	assert.equal(verifyReleaseGitProvenance("v1.2.3", successfulGit), commit);
	assert.throws(
		() =>
			verifyReleaseGitProvenance("v1.2.3", (...args) => {
				if (args[0] === "merge-base") throw new Error("not an ancestor");
				return successfulGit(...args);
			}),
		/not reachable from origin\/main/,
	);
	assert.throws(
		() =>
			verifyReleaseGitProvenance("v1.2.3", (...args) => {
				if (args[0] === "cat-file") return "commit";
				return successfulGit(...args);
			}),
		/must be an annotated tag/,
	);

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	assert.match(releaseScript, /git branch --show-current/);
	assert.match(releaseScript, /refs\/remotes\/origin\/main/);
	assert.match(releaseScript, /git tag -a -m/);
});

test("standalone runtime archives and the consolidated Node license are checksum pinned", () => {
	const runtime = JSON.parse(readFileSync("compliance/standalone-runtime.json", "utf8"));
	assert.equal(runtime.schemaVersion, 1);
	assert.equal(runtime.runtime, "node");
	assert.equal(runtime.version, "22.23.1");
	assert.equal(runtime.releaseBaseUrl, "https://nodejs.org/download/release/v22.23.1");
	assert.equal(
		runtime.seaDocumentation,
		"https://nodejs.org/download/release/v22.23.1/docs/api/single-executable-applications.html",
	);
	assert.deepEqual(runtime.license, {
		source: "https://raw.githubusercontent.com/nodejs/node/v22.23.1/LICENSE",
		sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4",
		path: "compliance/node-v22.23.1/LICENSE",
	});
	assert.equal(
		createHash("sha256").update(readFileSync(runtime.license.path)).digest("hex"),
		runtime.license.sha256,
	);

	const expectedTargets = {
		"darwin-arm64": {
			runner: "macos-15",
			archive: "node-v22.23.1-darwin-arm64.tar.gz",
			sha256: "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
		},
		"darwin-x64": {
			runner: "macos-15-intel",
			archive: "node-v22.23.1-darwin-x64.tar.gz",
			sha256: "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81",
		},
		"linux-arm64": {
			runner: "ubuntu-24.04-arm",
			archive: "node-v22.23.1-linux-arm64.tar.xz",
			sha256: "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1",
		},
		"linux-x64": {
			runner: "ubuntu-24.04",
			archive: "node-v22.23.1-linux-x64.tar.xz",
			sha256: "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
		},
		"windows-arm64": {
			runner: "windows-11-arm",
			archive: "node-v22.23.1-win-arm64.zip",
			sha256: "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0",
		},
		"windows-x64": {
			runner: "windows-2025",
			archive: "node-v22.23.1-win-x64.zip",
			sha256: "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29",
		},
	};
	assert.deepEqual(runtime.targets, expectedTargets);
});

test("binary license collection fails closed and records exact copied license bytes", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-binary-license-test-"));
	try {
		const packageRoot = join(directory, "fixture", "node_modules", "fixture-license-package");
		const input = join(packageRoot, "index.js");
		const metafile = join(directory, "binary-metafile.json");
		const licenses = join(directory, "LICENSES", "npm");
		const manifestPath = join(directory, "binary-license-manifest.json");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify({ name: "fixture-license-package", version: "1.2.3", license: "MIT" })}\n`,
		);
		writeFileSync(input, "export const fixture = true;\n");
		writeFileSync(metafile, `${JSON.stringify({ inputs: { [input]: { bytes: 29 } }, outputs: {} })}\n`);

		assert.throws(
			() => collectBinaryLicenses({ metafilePath: metafile, outputDirectory: licenses, manifestPath }),
			/fixture-license-package@1\.2\.3/,
		);

		const licenseBytes = Buffer.from("fixture license bytes\n");
		writeFileSync(join(packageRoot, "LICENSE"), licenseBytes);
		const manifest = collectBinaryLicenses({
			metafilePath: metafile,
			outputDirectory: licenses,
			manifestPath,
		});
		assert.equal(manifest.npmPackageCount, 1);
		assert.equal(manifest.packages[0].name, "fixture-license-package");
		assert.equal(manifest.packages[0].version, "1.2.3");
		assert.equal(manifest.packages[0].declaredLicense, "MIT");
		assert.equal(manifest.packages[0].licenseFiles.length, 1);
		assert.equal(
			manifest.packages[0].licenseFiles[0].sha256,
			createHash("sha256").update(licenseBytes).digest("hex"),
		);
		assert.deepEqual(
			readFileSync(join(licenses, "fixture-license-package-1.2.3", "LICENSE")),
			licenseBytes,
		);
		assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), manifest);

		const protectedDirectory = join(directory, "protected");
		const protectedFile = join(protectedDirectory, "keep.txt");
		mkdirSync(protectedDirectory);
		writeFileSync(protectedFile, "keep\n");
		assert.throws(
			() =>
				collectBinaryLicenses({
					metafilePath: metafile,
					outputDirectory: protectedDirectory,
					manifestPath: join(protectedDirectory, "manifest.json"),
				}),
			/owned LICENSES\/npm directory/,
		);
		assert.equal(readFileSync(protectedFile, "utf8"), "keep\n");

		const protectedPackagesDirectory = join(directory, "packages");
		const protectedPackageFile = join(protectedPackagesDirectory, "keep.txt");
		mkdirSync(protectedPackagesDirectory);
		writeFileSync(protectedPackageFile, "keep packages\n");
		assert.throws(
			() =>
				collectBinaryLicenses({
					metafilePath: metafile,
					outputDirectory: protectedPackagesDirectory,
					manifestPath,
				}),
			/owned LICENSES\/npm directory/,
		);
		assert.equal(readFileSync(protectedPackageFile, "utf8"), "keep packages\n");
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release preparation is owner-triggered and can only open a reviewed release pull request", () => {
	const workflow = readFileSync(".github/workflows/prepare-release.yml", "utf8");
	const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
	const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
	const ciTriggers = ciWorkflow.slice(ciWorkflow.indexOf("on:"), ciWorkflow.indexOf("concurrency:"));
	const checkout = workflow.slice(workflow.indexOf("      - name: Checkout"), workflow.indexOf("      - name: Setup Node.js"));
	const ciCheckout = ciWorkflow.slice(ciWorkflow.indexOf("      - name: Checkout"), ciWorkflow.indexOf("      - name: Setup Node.js"));
	const pullRequest = workflow.slice(workflow.indexOf("      - name: Push a release branch"));

	assert.match(triggers, /^  workflow_dispatch:/m);
	assert.doesNotMatch(triggers, /^  (?:push|pull_request|pull_request_target|release|schedule|workflow_call):/m);
	assert.match(workflow, /permissions: \{\}/);
	assert.match(workflow, /target:\s+description:[\s\S]*?type: choice\s+options:\s+- patch\s+- minor/);
	assert.doesNotMatch(workflow.slice(workflow.indexOf("      target:"), workflow.indexOf("permissions:")), /- major/);
	assert.match(workflow, /env:\s+RELEASE_OWNER: hansjm10/);
	assert.doesNotMatch(workflow, /github\.repository_owner|REPOSITORY_OWNER/);
	assert.match(workflow, /RUN_ACTOR: \$\{\{ github\.actor \}\}/);
	assert.match(workflow, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
	assert.match(
		workflow,
		/"\$\{RUN_ACTOR\}" != "\$\{RELEASE_OWNER\}".*\|\|.*"\$\{TRIGGERING_ACTOR\}" != "\$\{RELEASE_OWNER\}"/,
	);
	assert.match(workflow, /"\$\{GITHUB_REF\}" != "refs\/heads\/main"/);
	assert.match(workflow, /"\$\{RELEASE_TARGET\}" != "patch" && "\$\{RELEASE_TARGET\}" != "minor"/);
	assert.match(checkout, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6\.0\.2/);
	assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
	assert.match(checkout, /persist-credentials: false/);
	assert.doesNotMatch(checkout, /secrets\.|github-token|private-key|create-github-app-token/);
	assert.match(workflow, /node scripts\/release\.mjs prepare-pr "\$\{RELEASE_TARGET\}"/);
	assert.doesNotMatch(workflow, /VOLT_RELEASE_APP|actions\/create-github-app-token|permission-contents|private-key:/);
	assert.match(workflow, /permissions:\s+contents: write\s+pull-requests: write/);
	assert.doesNotMatch(workflow, /actions: write/);
	assert.match(pullRequest, /gh pr list --state open --base main --json headRefName,title,url/);
	assert.match(pullRequest, /startsWith|startswith/);
	assert.match(pullRequest, /branch="release\/\$\{RELEASE_TAG\}-\$\{GITHUB_RUN_ID\}"/);
	assert.doesNotMatch(pullRequest, /GITHUB_RUN_ATTEMPT/);
	assert.match(pullRequest, /git\/ref\/heads\/\$\{branch\}/);
	assert.match(pullRequest, /git fetch origin "refs\/heads\/\$\{branch\}:\$\{remote_ref\}"/);
	assert.match(pullRequest, /git rev-parse HEAD\^\{tree\}.*git rev-parse "\$\{remote_ref\}\^\{tree\}"/);
	assert.match(pullRequest, /git rev-parse "\$\{remote_ref\}\^".*git rev-parse refs\/remotes\/origin\/main/);
	assert.match(pullRequest, /git push origin "HEAD:refs\/heads\/\$\{branch\}"/);
	assert.match(pullRequest, /gh pr list --state all --head "\$\{branch\}" --json url,mergedAt,state/);
	assert.match(pullRequest, /gh pr create[\s\S]*?--base main[\s\S]*?--head "\$\{branch\}"/);
	assert.match(pullRequest, /gh pr reopen "\$\{pr_url\}"/);
	assert.match(pullRequest, /Approve the pending pull-request workflows so CI tests the GitHub merge ref/);
	assert.doesNotMatch(workflow, /gh workflow run|createWorkflowDispatch/);
	assert.doesNotMatch(workflow, /git push origin (?:main|"?(?:HEAD:)?refs\/heads\/main)/);

	assert.match(ciTriggers, /^  push:\s+branches: \[main\]/m);
	assert.match(ciTriggers, /^  pull_request:\s+branches: \[main\]/m);
	assert.doesNotMatch(ciTriggers, /workflow_dispatch|workflow_call|pull_request_target/);
	assert.match(ciWorkflow, /permissions: \{\}/);
	assert.match(ciWorkflow, /timeout-minutes: 45/);
	assert.match(ciWorkflow, /permissions:\s+contents: read/);
	assert.match(ciCheckout, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6\.0\.2/);
	assert.match(ciCheckout, /persist-credentials: false/);
	assert.doesNotMatch(ciCheckout, /^\s+ref:/m);
});

test("release approval separates read-only authorization, App tagging, and publication", () => {
	const workflow = readFileSync(".github/workflows/approve-release.yml", "utf8");
	const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
	const preflight = workflow.slice(workflow.indexOf("  preflight:"), workflow.indexOf("  tag-release:"));
	const tagRelease = workflow.slice(workflow.indexOf("  tag-release:"), workflow.indexOf("  dispatch-publication:"));
	const dispatch = workflow.slice(workflow.indexOf("  dispatch-publication:"));

	assert.match(triggers, /^  workflow_dispatch:/m);
	assert.doesNotMatch(triggers, /^  (?:push|pull_request|pull_request_target|release|schedule|workflow_call):/m);
	assert.match(workflow, /permissions: \{\}/);
	const inputs = [
		"version",
		"candidate_commit",
		"candidate_run_id",
		"candidate_artifact_digest",
		"license_compliance_approved",
		"native_smoke_tests_approved",
		"unsigned_windows_acknowledged",
		"authorization_phrase",
		"confirm_release",
	];
	const permissionsIndex = workflow.indexOf("permissions:");
	for (const [index, input] of inputs.entries()) {
		const start = workflow.indexOf(`      ${input}:`);
		const next = index + 1 < inputs.length ? workflow.indexOf(`      ${inputs[index + 1]}:`) : permissionsIndex;
		assert.ok(start !== -1 && next > start, `missing workflow-dispatch input ${input}`);
		assert.match(workflow.slice(start, next), /required: true/);
	}
	for (const input of [
		"license_compliance_approved",
		"native_smoke_tests_approved",
		"unsigned_windows_acknowledged",
		"confirm_release",
	]) {
		const start = workflow.indexOf(`      ${input}:`);
		const nextInput = inputs[inputs.indexOf(input) + 1];
		const end = nextInput ? workflow.indexOf(`      ${nextInput}:`) : permissionsIndex;
		assert.match(workflow.slice(start, end), /type: boolean/);
	}

	assert.match(preflight, /permissions:\s+actions: read\s+attestations: read\s+contents: read/);
	assert.doesNotMatch(preflight, /actions: write|attestations: write|contents: write/);
	assert.match(workflow, /env:\s+RELEASE_OWNER: hansjm10/);
	assert.doesNotMatch(workflow, /github\.repository_owner|REPOSITORY_OWNER/);
	assert.match(preflight, /RUN_ACTOR: \$\{\{ github\.actor \}\}/);
	assert.match(preflight, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
	assert.match(
		preflight,
		/"\$\{RUN_ACTOR\}" != "\$\{RELEASE_OWNER\}".*\|\|.*"\$\{TRIGGERING_ACTOR\}" != "\$\{RELEASE_OWNER\}"/,
	);
	assert.match(preflight, /"\$\{GITHUB_REF\}" != "refs\/heads\/main"/);
	assert.match(preflight, /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);
	assert.match(preflight, /\^\[0-9a-f\]\{40\}\$/);
	assert.match(preflight, /"\$\{GITHUB_SHA\}" != "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(preflight, /\^\[1-9\]\[0-9\]\*\$/);
	assert.match(preflight, /\^sha256:\[0-9a-f\]\{64\}\$/);
	for (const acknowledgement of [
		"LICENSE_COMPLIANCE_APPROVED",
		"NATIVE_SMOKE_TESTS_APPROVED",
		"UNSIGNED_WINDOWS_ACKNOWLEDGED",
		"CONFIRM_RELEASE",
	]) {
		assert.match(preflight, new RegExp(`"\\$\\{${acknowledgement}\\}"`));
	}
	assert.match(preflight, /if \[\[ "\$\{acknowledgement\}" != "true" \]\]/);
	assert.match(
		preflight,
		/expected_phrase="release v\$\{APPROVED_VERSION\} from \$\{CANDIDATE_COMMIT\} using run \$\{CANDIDATE_RUN_ID\} and \$\{CANDIDATE_ARTIFACT_DIGEST\}"/,
	);
	assert.match(preflight, /"\$\{AUTHORIZATION_PHRASE\}" != "\$\{expected_phrase\}"/);
	assert.match(preflight, /ref: main/);
	assert.match(preflight, /persist-credentials: false/);
	assert.match(preflight, /git branch --show-current.*!= "main"/);
	assert.match(preflight, /git rev-parse HEAD.*!= "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(preflight, /git rev-parse refs\/remotes\/origin\/main.*!= "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(preflight, /node scripts\/release\.mjs authorize "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(preflight, /VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST: \$\{\{ inputs\.candidate_artifact_digest \}\}/);
	assert.match(preflight, /VOLT_APPROVED_CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}/);
	for (const output of [
		"tag",
		"version",
		"candidate-commit",
		"candidate-run-id",
		"candidate-artifact-digest",
		"tag-message-base64",
	]) {
		assert.match(preflight, new RegExp(`${output}: \\$\\{\\{ steps\\.authorize\\.outputs\\.${output} \\}\\}`));
	}
	assert.match(preflight, /artifact_name="standalone-candidate-\$\{CANDIDATE_COMMIT\}"/);
	assert.match(preflight, /actions\/runs\/\$\{CANDIDATE_RUN_ID\}\/artifacts/);
	assert.match(preflight, /select\(\.name == \$name and \.expired == false\)/);
	assert.match(preflight, /Approved run must contain exactly one unexpired/);
	assert.match(preflight, /artifact_id=\$\(jq -r '\.\[0\]\.id'/);
	assert.match(preflight, /artifact_digest=\$\(jq -r '\.\[0\]\.digest'/);
	assert.match(preflight, /artifact_digest.*!= "\$\{CANDIDATE_ARTIFACT_DIGEST\}"/);
	assert.match(preflight, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.id \}\}/);
	assert.match(preflight, /merge-multiple: true/);
	assert.match(preflight, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
	assert.match(preflight, /path: approved-candidate/);
	assert.match(preflight, /Approved candidate contains an unexpected top-level entry/);
	assert.match(preflight, /source-commit\.txt/);
	assert.match(preflight, /wc -l < SHA256SUMS/);
	assert.match(preflight, /sha256sum --strict -c SHA256SUMS/);
	assert.match(preflight, /release-record\.json/);
	for (const field of [
		".schemaVersion == 1",
		'.workflow.path == ".github/workflows/build-standalone-candidate.yml"',
		".workflow.runId == $run_id",
		".candidate.commit == $commit",
		'.candidate.ref == "refs/heads/main"',
		".artifact.name == $artifact",
		'(.archives | type == "array" and length == 6)',
	]) {
		assert.ok(preflight.includes(field), `missing release-record check: ${field}`);
	}
	for (const asset of [
		"volt-darwin-arm64.tar.gz",
		"volt-darwin-x64.tar.gz",
		"volt-linux-arm64.tar.gz",
		"volt-linux-x64.tar.gz",
		"volt-windows-arm64.zip",
		"volt-windows-x64.zip",
	]) {
		assert.match(preflight, new RegExp(`\\b${asset.replaceAll(".", "\\.")}\\b`));
	}
	assert.match(preflight, /gh attestation verify "\$\{asset\}"/);
	assert.match(preflight, /gh attestation verify release-record\.json/);
	assert.match(preflight, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/build-standalone-candidate\.yml"/);
	assert.equal(preflight.match(/--source-digest "\$\{CANDIDATE_COMMIT\}"/g)?.length, 2);
	assert.equal(preflight.match(/--source-ref refs\/heads\/main/g)?.length, 2);
	assert.equal(preflight.match(/--deny-self-hosted-runners/g)?.length, 2);
	assert.doesNotMatch(preflight, /VOLT_RELEASE_APP|create-github-app-token|private-key:|git\.createTag|git\.createRef|repos\.createRelease/);

	assert.match(tagRelease, /environment: release-authorization/);
	assert.match(tagRelease, /permissions:\s+actions: read\s+contents: read/);
	assert.doesNotMatch(tagRelease, /actions\/checkout@/);
	assert.equal(workflow.match(/actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/g)?.length, 1);
	const createToken = tagRelease.slice(
		tagRelease.indexOf("      - name: Mint a repository-scoped Release Tagger token"),
		tagRelease.indexOf("      - name: Create and read back"),
	);
	assert.match(createToken, /client-id: \$\{\{ vars\.VOLT_RELEASE_APP_CLIENT_ID \}\}/);
	assert.match(createToken, /private-key: \$\{\{ secrets\.VOLT_RELEASE_APP_PRIVATE_KEY \}\}/);
	assert.match(createToken, /permission-contents: write/);
	assert.equal(createToken.match(/^\s+permission-[a-z-]+:/gm)?.length, 1);
	assert.doesNotMatch(createToken, /^\s+(?:owner|repositories):/m);
	const outsideTagRelease = workflow.slice(0, workflow.indexOf("  tag-release:")) + workflow.slice(workflow.indexOf("  dispatch-publication:"));
	assert.doesNotMatch(outsideTagRelease, /VOLT_RELEASE_APP|steps\.release-app\.outputs\.token|actions\/create-github-app-token/);
	assert.match(tagRelease, /github-token: \$\{\{ steps\.release-app\.outputs\.token \}\}/);
	assert.match(
		tagRelease,
		/process\.env\.RUN_ACTOR !== process\.env\.RELEASE_OWNER \|\| process\.env\.TRIGGERING_ACTOR !== process\.env\.RELEASE_OWNER/,
	);
	const privilegedTagMutation = tagRelease.slice(tagRelease.indexOf("      - name: Create and read back"));
	assert.match(privilegedTagMutation, /github\.rest\.repos\.getBranch\(\{ owner, repo, branch: "main" \}\)/);
	assert.match(privilegedTagMutation, /main\.data\.commit\.sha !== candidateCommit/);
	assert.ok(
		privilegedTagMutation.indexOf("github.rest.repos.getBranch") < privilegedTagMutation.indexOf("github.rest.git.createTag"),
	);
	assert.match(tagRelease, /github\.rest\.git\.createTag\(\{/);
	assert.match(tagRelease, /github\.rest\.git\.createRef\(\{/);
	assert.match(tagRelease, /object: candidateCommit,\s+type: "commit"/);
	assert.doesNotMatch(tagRelease, /git\.(?:updateRef|deleteRef)|force:\s*true|git push|gh api/);
	assert.match(tagRelease, /github\.rest\.repos\.createRelease\(\{/);
	assert.match(tagRelease, /draft: true,\s+prerelease: false,\s+make_latest: "false"/);
	assert.match(tagRelease, /!matches\[0\]\.draft \|\| matches\[0\]\.prerelease/);

	assert.match(dispatch, /needs: \[preflight, tag-release\]/);
	assert.match(dispatch, /permissions:\s+actions: write\s+contents: read/);
	assert.doesNotMatch(dispatch, /VOLT_RELEASE_APP|release-app|github-token:|private-key:|contents: write/);
	assert.match(dispatch, /github\.rest\.actions\.createWorkflowDispatch\(\{/);
	assert.match(dispatch, /workflow_id: "build-binaries\.yml"/);
	assert.match(dispatch, /ref: process\.env\.RELEASE_TAG/);
	assert.match(dispatch, /inputs: \{ tag: process\.env\.RELEASE_TAG \}/);

	assert.doesNotMatch(workflow, /next-cycle|open-next-cycle|\[Unreleased\]/);
});

test("publisher is dispatch-only, tag-bound, approval-bound, and cannot replace release bytes", () => {
	const workflow = readFileSync(".github/workflows/build-binaries.yml", "utf8");
	const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
	const validateJob = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  assemble:"));
	const assembleJob = workflow.slice(workflow.indexOf("  assemble:"), workflow.indexOf("  publish-npm:"));
	const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  release:"));
	const releaseJob = workflow.slice(workflow.indexOf("  release:"));

	assert.match(triggers, /^  workflow_dispatch:/m);
	assert.match(triggers, /tag:\s+description:[\s\S]*?required: true\s+type: string/);
	assert.doesNotMatch(triggers, /^  (?:push|pull_request|pull_request_target|release|schedule|workflow_call):/m);
	assert.match(workflow, /concurrency:\s+group: publish-release-\$\{\{ inputs\.tag \}\}\s+cancel-in-progress: false/);
	assert.doesNotMatch(workflow, /source_ref|SOURCE_REF|--clobber/);
	assert.doesNotMatch(workflow, /^\s*cache:\s*npm\s*$/m);
	assert.doesNotMatch(workflow, /oven-sh|setup-bun|bun build/i);
	assert.doesNotMatch(workflow, /build-standalone:|matrix\.runner|build-binaries\.sh/);
	assert.equal(workflow.match(/RELEASE_TAG: \$\{\{ inputs\.tag \}\}/g)?.length, 4);
	assert.equal(workflow.match(/"\$\{GITHUB_EVENT_NAME\}" != "workflow_dispatch"/g)?.length, 4);
	assert.equal(workflow.match(/"\$\{GITHUB_REF\}" != "refs\/tags\/\$\{RELEASE_TAG\}"/g)?.length, 4);
	assert.equal(workflow.match(/actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6\.0\.2/g)?.length, 4);
	assert.equal(workflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g)?.length, 4);
	assert.equal(workflow.match(/persist-credentials: false/g)?.length, 4);
	assert.equal(workflow.match(/git cat-file -t "refs\/tags\/\$\{RELEASE_TAG\}"/g)?.length, 4);
	assert.equal(workflow.match(/"\$\{GITHUB_SHA\}" != "\$\{tag_commit\}"/g)?.length, 4);
	assert.equal(workflow.match(/"\$\{checkout_commit\}" != "\$\{tag_commit\}"/g)?.length, 4);
	assert.equal(workflow.match(/actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\.4\.0/g)?.length, 3);
	assert.equal(workflow.match(/node-version: '22\.23\.1'/g)?.length, 3);
	assert.equal(workflow.match(/package-manager-cache: false/g)?.length, 3);
	assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
	assert.match(workflow, /actions\/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3/);
	assert.match(workflow, /verify-release-provenance\.mjs --tag/);
	assert.match(workflow, /verify-npm-package-bootstrap\.mjs tag --version/);

	assert.match(validateJob, /permissions:\s+contents: read/);
	assert.match(validateJob, /npm run check:release-security/);
	assert.ok(validateJob.indexOf("npm ci --ignore-scripts") < validateJob.indexOf("npm run check:release-security"));

	assert.match(assembleJob, /needs: validate/);
	assert.match(assembleJob, /permissions:\s+actions: read\s+attestations: read\s+contents: read/);
	assert.match(assembleJob, /Standalone-Candidate-Commit:/);
	assert.match(assembleJob, /Standalone-Candidate-Run:/);
	assert.match(assembleJob, /Standalone-Candidate-Artifact-Digest:/);
	assert.match(assembleJob, /Release-Approval-Run:/);
	assert.match(assembleJob, /Legacy v0\.1\.0 must retain its original immutable authorization message/);
	assert.match(assembleJob, /\^sha256:\[0-9a-f\]\{64\}\$/);
	assert.match(assembleJob, /actions\/runs\/\$\{candidate_run_id\}/);
	assert.match(assembleJob, /\.github\/workflows\/build-standalone-candidate\.yml/);
	for (const binding of ["head_sha", "head_branch", "event", "status", "conclusion", "workflow_path"]) {
		assert.match(assembleJob, new RegExp(binding));
	}
	assert.match(assembleJob, /artifact_name="standalone-candidate-\$\{source_commit\}"/);
	assert.match(assembleJob, /select\(\.name == \$artifact_name and \.expired == false\)/);
	assert.match(assembleJob, /api_digest=\$\(jq -r '\.\[0\]\.digest'/);
	assert.match(assembleJob, /artifact_id=\$\(jq -r '\.\[0\]\.id'/);
	assert.match(assembleJob, /candidate_digests\[0\].*api_digest/);
	assert.match(assembleJob, /actions\/runs\/\$\{approval_run_id\}/);
	assert.match(assembleJob, /approval_path.*\.github\/workflows\/approve-release\.yml/);
	assert.match(assembleJob, /artifact-ids: \$\{\{ steps\.candidate\.outputs\.artifact-id \}\}/);
	assert.match(assembleJob, /merge-multiple: true/);
	assert.match(assembleJob, /run-id: \$\{\{ steps\.candidate\.outputs\.run-id \}\}/);
	assert.match(assembleJob, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
	assert.match(assembleJob, /exactly nine top-level files/);
	assert.match(assembleJob, /Candidate artifact commit .* does not match tag commit/);
	assert.match(assembleJob, /Unexpected standalone archive set/);
	assert.match(assembleJob, /sha256sum --strict -c SHA256SUMS/);
	assert.match(assembleJob, /release-record\.json/);
	for (const field of [
		".schemaVersion == 1",
		'.workflow.name == "Build Standalone Candidate"',
		'.workflow.path == ".github/workflows/build-standalone-candidate.yml"',
		".workflow.runId == $run_id",
		".candidate.commit == $candidate_commit",
		'.candidate.ref == "refs/heads/main"',
		".artifact.name == $artifact_name",
		"(.archives | type == \"array\" and length == 6)",
	]) {
		assert.ok(assembleJob.includes(field), `publisher is missing release-record check: ${field}`);
	}
	assert.match(assembleJob, /Release record digest does not match SHA256SUMS/);
	assert.match(assembleJob, /gh attestation verify "\$\{asset\}"/);
	assert.match(assembleJob, /gh attestation verify release-record\.json/);
	assert.match(assembleJob, /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/build-standalone-candidate\.yml"/);
	assert.equal(assembleJob.match(/--source-digest "\$\{\{ steps\.candidate\.outputs\.source-commit \}\}"/g)?.length, 2);
	assert.equal(assembleJob.match(/--source-ref refs\/heads\/main/g)?.length, 2);
	assert.equal(assembleJob.match(/--deny-self-hosted-runners/g)?.length, 2);

	assert.match(publishJob, /needs: assemble/);
	assert.match(publishJob, /environment: npm-publish/);
	assert.match(publishJob, /permissions:\s+contents: read\s+id-token: write/);
	assert.match(publishJob, /mkdir -p \/tmp\/ws/);
	assert.equal(publishJob.match(/^\s+run: npm test$/gm)?.length, 1);
	assert.equal(publishJob.match(/^\s+run: node scripts\/publish\.mjs$/gm)?.length, 1);
	assert.doesNotMatch(publishJob, /v0\.1\.0|recovery|retr(?:y|ied)|git show|git restore|^\s*trap\b/m);
	assert.equal(publishJob.match(/git diff --exit-code HEAD/g)?.length, 2);
	assert.ok(publishJob.indexOf("npm test") < publishJob.indexOf("node scripts/publish.mjs"));
	assert.ok(publishJob.indexOf("node scripts/publish.mjs") < publishJob.lastIndexOf("git diff --exit-code HEAD"));
	assert.ok(publishJob.indexOf("node scripts/publish.mjs") < publishJob.indexOf("verify-npm-package-bootstrap.mjs tag --version"));

	assert.match(releaseJob, /needs: \[assemble, publish-npm\]/);
	assert.match(releaseJob, /environment: binary-release/);
	assert.match(releaseJob, /permissions:\s+contents: write/);
	assert.match(releaseJob, /source-commit\.txt/);
	assert.match(releaseJob, /Release artifact commit .* does not match checked-out tag commit/);
	const releaseAssetMatch = /release_assets=\(\n([\s\S]*?)\n          \)/.exec(releaseJob);
	assert.ok(releaseAssetMatch, "missing public release asset list");
	assert.deepEqual(
		releaseAssetMatch[1].split("\n").map((line) => line.trim()),
		[
			"volt-darwin-arm64.tar.gz",
			"volt-darwin-x64.tar.gz",
			"volt-linux-arm64.tar.gz",
			"volt-linux-x64.tar.gz",
			"volt-windows-arm64.zip",
			"volt-windows-x64.zip",
			"SHA256SUMS",
			"release-record.json",
		],
	);
	assert.match(releaseJob, /internal_files=\("\$\{release_assets\[@\]\}" release-notes\.md source-commit\.txt\)/);
	assert.match(releaseJob, /exactly ten top-level files/);
	assert.match(releaseJob, /gh release view "\$\{RELEASE_TAG\}" --json assets,isDraft,isPrerelease,tagName/);
	assert.match(releaseJob, /Release approval must create the stable draft before publication/);
	assert.match(releaseJob, /Pre-authorized GitHub release must be stable/);
	assert.match(releaseJob, /Release contains an unexpected asset/);
	assert.doesNotMatch(workflow, /gh release create|--clobber/);
	const compareExisting = releaseJob.indexOf('for existing_asset in "${existing_assets[@]}"; do', releaseJob.indexOf("compare_dir="));
	const uploadMissing = releaseJob.indexOf('for asset in "${release_assets[@]}"; do', compareExisting);
	assert.ok(compareExisting !== -1 && uploadMissing > compareExisting);
	assert.ok(releaseJob.indexOf("cmp -s", compareExisting) < uploadMissing);
	assert.match(releaseJob, /Published release is missing required asset/);
	assert.match(releaseJob, /gh release upload "\$\{RELEASE_TAG\}" "\$\{asset\}"/);
	assert.match(releaseJob, /Release asset set does not exactly match the approved public asset set/);
	assert.equal(releaseJob.match(/Refusing to replace existing release asset with different bytes/g)?.length, 2);
	assert.match(releaseJob, /if \[\[ "\$\{is_draft\}" == "true" \]\]/);
	assert.match(releaseJob, /gh release edit "\$\{RELEASE_TAG\}" \\\s+--draft=false \\\s+--prerelease=false \\\s+--latest/);
	assert.match(releaseJob, /Stable GitHub release did not reach the expected published state/);
	assert.match(releaseJob, /releases\/latest/);
	assert.match(releaseJob, /GitHub latest release is/);
});

test("pre-tag standalone candidates build the exact main commit without publishing", () => {
	const workflow = readFileSync(".github/workflows/build-standalone-candidate.yml", "utf8");
	const validateJob = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  build-standalone:"));
	const buildJob = workflow.slice(workflow.indexOf("  build-standalone:"), workflow.indexOf("  assemble:"));
	const assembleJob = workflow.slice(workflow.indexOf("  assemble:"));
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /env:\s+RELEASE_OWNER: hansjm10/);
	assert.doesNotMatch(workflow, /github\.repository_owner|REPOSITORY_OWNER/);
	assert.match(validateJob, /RUN_ACTOR: \$\{\{ github\.actor \}\}/);
	assert.match(validateJob, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
	assert.match(
		validateJob,
		/"\$\{RUN_ACTOR\}" != "\$\{RELEASE_OWNER\}".*\|\|.*"\$\{TRIGGERING_ACTOR\}" != "\$\{RELEASE_OWNER\}"/,
	);
	assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
	assert.match(workflow, /git rev-parse HEAD/);
	assert.match(workflow, /git rev-parse refs\/remotes\/origin\/main/);
	assert.match(workflow, /test "\$\{GITHUB_SHA\}" = "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/heads\/main"/);
	assert.match(workflow, /npm run check:release-security/);
	assert.match(workflow, /VOLT_REQUIRE_CLEAN_SOURCE: '1'/);
	assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
	assert.match(workflow, /\.\/scripts\/build-binaries\.sh --skip-install --skip-build --platform/);
	for (const [target, runner] of [
		["darwin-arm64", "macos-15"],
		["darwin-x64", "macos-15-intel"],
		["linux-arm64", "ubuntu-24.04-arm"],
		["linux-x64", "ubuntu-24.04"],
		["windows-arm64", "windows-11-arm"],
		["windows-x64", "windows-2025"],
	]) {
		assert.match(workflow, new RegExp(`- target: ${target}\\s+runner: ${runner}`));
	}
	assert.match(workflow, /standalone-candidate-\$\{\{ inputs\.commit \}\}/);
	assert.match(workflow, /LC_ALL=C sha256sum/);
	assert.match(validateJob, /permissions:\s+contents: read/);
	assert.match(buildJob, /permissions:\s+contents: read/);
	for (const job of [validateJob, buildJob]) {
		assert.doesNotMatch(job, /artifact-metadata: write|attestations: write|contents: write|id-token: write/);
	}
	assert.match(
		assembleJob,
		/permissions:\s+artifact-metadata: write\s+attestations: write\s+contents: read\s+id-token: write/,
	);
	assert.equal(
		assembleJob.match(/actions\/attest@a1948c3f048ba23858d222213b7c278aabede763 # v4\.1\.1/g)?.length,
		2,
	);
	assert.match(assembleJob, /subject-checksums: standalone-candidate\/SHA256SUMS/);
	assert.match(assembleJob, /subject-path: standalone-candidate\/release-record\.json/);
	assert.match(assembleJob, /id: upload-candidate/);
	assert.match(assembleJob, /standalone-candidate\/release-record\.json/);
	assert.match(assembleJob, /steps\.upload-candidate\.outputs\.artifact-digest/);
	assert.doesNotMatch(workflow, /contents: write|npm publish|publish\.mjs|gh release|secrets\./);
});

test("installers use the published package and verify binary checksums before exact extraction", () => {
	const shellInstaller = readFileSync("site/public/install.sh", "utf8");
	const windowsInstaller = readFileSync("site/public/install.ps1", "utf8");
	for (const installer of [shellInstaller, windowsInstaller]) {
		assert.match(installer, /@hansjm10\/volt-coding-agent/);
		assert.doesNotMatch(installer, /@hansjm10\/volt-cli/);
		assert.match(installer, /SHA256SUMS/);
		assert.match(installer, /SHA-256 verification failed/);
		assert.match(installer, /local CLI\/TUI only/i);
	}
	assert.match(shellInstaller, /npm_spec="\$PACKAGE@beta"/);
	assert.match(windowsInstaller, /\$npmSpec = "\$package@beta"/);
	assert.match(shellInstaller, /tar -xzf "\$tmp\/\$asset" -C "\$tmp\/extract"/);
	assert.match(shellInstaller, /standalone-file-manifest\.json/);
	assert.match(shellInstaller, /release_tag="v\$\{VERSION#v\}"/);
	assert.doesNotMatch(shellInstaller, /find .* -name volt/);
	assert.match(windowsInstaller, /FullName -eq "volt\.exe"/);
	assert.match(windowsInstaller, /ExtractToDirectory/);
	assert.match(windowsInstaller, /standalone-file-manifest\.json/);
	assert.match(windowsInstaller, /\$releaseTag = "v\$\(\$version\.TrimStart\('v'\)\)"/);
	assert.doesNotMatch(windowsInstaller, /Expand-Archive/);
	assert.equal(spawnSync(posixShell, ["-n", "site/public/install.sh"]).status, 0);
});

test("site sources preserve the package identity and beta/relay disclosures", () => {
	for (const file of [
		"site/src/pages/index.astro",
		"site/scripts/sync-docs.mjs",
		"site/README.md",
		"site/public/install.sh",
		"site/public/install.ps1",
	]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), /@hansjm10\/volt-cli/, file);
	}
	const landingPage = readFileSync("site/src/pages/index.astro", "utf8");
	assert.match(landingPage, /public beta/i);
	assert.match(landingPage, /connects\s+devices directly when possible and falls back to end-to-end encrypted relays/i);
});

test("published packages and binary build include the repository license and notices", () => {
	const rootLicense = readFileSync("LICENSE", "utf8");
	for (const directory of RELEASE_PACKAGES) {
		assert.equal(readFileSync(`${directory}/LICENSE`, "utf8").trimEnd(), rootLicense.trimEnd());
		const manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
		assert.equal(manifest.license, "MIT");
		assert.deepEqual(manifest.contributors, ["Mario Zechner", "Jordan Hans"]);
		assert.equal(manifest.repository.url, "git+https://github.com/volt-hq/Volt.git");
		assert.equal(manifest.repository.directory, directory);
		assert.deepEqual(manifest.publishConfig, { access: "public", tag: "latest" });
	}
	const buildScript = readFileSync("scripts/build-binaries.sh", "utf8");
	const standaloneBuild = readFileSync("scripts/build-standalone.mjs", "utf8");
	for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md", "BINARY-CAPABILITIES.md", "npm-shrinkwrap.json"]) {
		assert.match(standaloneBuild, new RegExp(`"${file.replaceAll(".", "\\.")}"`));
	}
	const codingAgentManifest = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
	assert.ok(codingAgentManifest.files.includes("!docs/images/doom-extension.png"));
	assert.ok(codingAgentManifest.files.includes("!examples/**/node_modules/**"));
	assert.ok(codingAgentManifest.files.includes("!examples/extensions/doom-overlay"));
	assert.ok(codingAgentManifest.files.includes("!examples/extensions/doom-overlay/**"));
	const packCache = mkdtempSync(join(tmpdir(), "volt-npm-pack-cache-"));
	try {
		const packResult = JSON.parse(
			execNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: "packages/coding-agent",
				encoding: "utf8",
				env: { ...process.env, npm_config_cache: packCache },
			}),
		);
		assert.equal(packResult.length, 1);
		assert.equal(
			packResult[0].files.some(
				({ path }) =>
					path === "docs/images/doom-extension.png" ||
					path === "examples/extensions/doom-overlay" ||
					path.startsWith("examples/extensions/doom-overlay/"),
			),
			false,
		);
		const packedPaths = new Set(packResult[0].files.map(({ path }) => path));
		const nativeRoot = "packages/coding-agent/native/workspace-fs";
		const manifest = JSON.parse(readFileSync(`${nativeRoot}/prebuilds/manifest.json`, "utf8"));
		const expectedTargets = [
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64-gnu",
			"linux-arm64-musl",
			"linux-x64-gnu",
			"linux-x64-musl",
			"win32-arm64-msvc",
			"win32-x64-msvc",
		];
		assert.equal(manifest.schemaVersion, 1);
		assert.equal(manifest.apiVersion, "volt-workspace-fs-v1");
		assert.match(manifest.sourceFingerprint, /^[0-9a-f]{64}$/);
		assert.deepEqual(
			manifest.artifacts.map(({ target }) => target),
			expectedTargets,
		);
		const expectedPackedNativeFiles = ["native/workspace-fs/prebuilds/manifest.json"];
		for (const artifact of manifest.artifacts) {
			assert.equal(artifact.path, `${artifact.target}/workspace-fs.node`);
			const bytes = readFileSync(`${nativeRoot}/prebuilds/${artifact.path}`);
			assert.equal(artifact.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
			expectedPackedNativeFiles.push(`native/workspace-fs/prebuilds/${artifact.path}`);
		}
		const collectLicenseFiles = (directory, prefix = "") => {
			const files = [];
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const entryPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) files.push(...collectLicenseFiles(join(directory, entry.name), entryPrefix));
				else if (entry.isFile()) files.push(entryPrefix);
				else assert.fail(`native license entry is not a regular file: ${entryPrefix}`);
			}
			return files;
		};
		const licenseFiles = collectLicenseFiles(`${nativeRoot}/licenses`).sort();
		expectedPackedNativeFiles.push(...licenseFiles.map((path) => `native/workspace-fs/licenses/${path}`));
		const packedNativeFiles = [...packedPaths].filter((path) => path.startsWith("native/workspace-fs/")).sort();
		assert.deepEqual(packedNativeFiles, expectedPackedNativeFiles.sort());
		assert.equal(
			[...packedPaths].some(
				(path) =>
					path.startsWith("native/workspace-fs/src/") ||
					["Cargo.toml", "Cargo.lock", "build.rs", "deny.toml", "rust-toolchain.toml"].some(
						(name) => path === `native/workspace-fs/${name}`,
					),
			),
			false,
		);
	} finally {
		rmSync(packCache, { force: true, recursive: true });
	}
	execFileSync(process.execPath, ["scripts/workspace-fs-native.mjs", "verify-licenses"], { stdio: "pipe" });
	const nativeLicenseInventory = JSON.parse(
		readFileSync("packages/coding-agent/native/workspace-fs/licenses/inventory.json", "utf8"),
	);
	assert.equal(nativeLicenseInventory.schemaVersion, 1);
	assert.match(nativeLicenseInventory.cargoLockSha256, /^[0-9a-f]{64}$/);
	const nativeLicenseManifest = JSON.parse(
		readFileSync("packages/coding-agent/native/workspace-fs/prebuilds/manifest.json", "utf8"),
	);
	assert.equal(nativeLicenseInventory.sourceFingerprint, nativeLicenseManifest.sourceFingerprint);
	assert.equal(nativeLicenseInventory.packages.length > 0, true);
	const rustLicenseOverrides = JSON.parse(readFileSync("compliance/rust-license-overrides.json", "utf8"));
	assert.equal(rustLicenseOverrides.schemaVersion, 1);
	for (const override of Object.values(rustLicenseOverrides.packages)) {
		assert.match(override.source, /^https:\/\/github\.com\//);
		for (const file of override.files) {
			assert.equal(
				createHash("sha256").update(readFileSync(file.path)).digest("hex"),
				file.sha256,
			);
		}
	}
	assert.match(standaloneBuild, /remote\/firebase-push-relay\/functions\/node_modules/);
	assert.match(standaloneBuild, /extensions\/doom-overlay/);
	assert.match(standaloneBuild, /Doom overlay must not be present in standalone release staging/);
	assert.match(standaloneBuild, /Standalone staging contains unexpected WASM files/);
	assert.match(standaloneBuild, /Standalone staging contains unexpected binary files/);
	assert.match(standaloneBuild, /copyWorkspaceFsAssets/);
	assert.match(standaloneBuild, /assertStagedWorkspaceFsAddon/);
	assert.match(standaloneBuild, /workspace-fs-rust/);
	assert.match(standaloneBuild, /native\/workspace-fs\/prebuilds/);
	assert.match(standaloneBuild, /Workspace filesystem addon checksum mismatch/);
	assert.match(standaloneBuild, /Workspace filesystem Rust license tree does not exactly match inventory\.json/);
	assert.match(standaloneBuild, /Standalone workspace filesystem addon fingerprint does not match its manifest/);
	assert.match(standaloneBuild, /git.*ls-files/);
	assert.match(standaloneBuild, /images\/doom-extension\.png/);
	assert.match(standaloneBuild, /binary-metafile\.json/);
	assert.match(standaloneBuild, /binary-license-manifest\.json/);
	assert.match(standaloneBuild, /standalone-file-manifest\.json/);
	assert.match(standaloneBuild, /normalizedArchiveFileMode/);
	assert.match(standaloneBuild, /stagedPath === "volt\.exe".*"0755".*"0644"/s);
	assert.match(standaloneBuild, /sourceTreeClean/);
	assert.match(standaloneBuild, /VOLT_REQUIRE_CLEAN_SOURCE/);
	assert.match(standaloneBuild, /process\.platform === "win32".*powershell\.exe.*Expand-Archive/s);
	assert.match(standaloneBuild, /VOLT_NODE_ARCHIVE.*VOLT_NODE_RUNTIME/s);
	assert.match(standaloneBuild, /collect-binary-licenses\.mjs/);
	assert.match(standaloneBuild, /node-v\$\{runtime\.version\}-LICENSE\.txt/);
	assert.match(standaloneBuild, /Node runtime license checksum mismatch/);

	const licenseCopies = [
		["node_modules/clipboard-image/license", "packages/coding-agent/dist/LICENSES/clipboard-image-MIT.txt"],
		["node_modules/run-jxa/license", "packages/coding-agent/dist/LICENSES/run-jxa-MIT.txt"],
		["node_modules/highlight.js/LICENSE", "packages/coding-agent/dist/LICENSES/highlight.js-10.7.3-BSD-3-Clause.txt"],
		[
			"packages/coding-agent/src/core/export-html/vendor/highlight.LICENSE",
			"packages/coding-agent/dist/LICENSES/highlight.js-11.9.0-BSD-3-Clause.txt",
		],
		[
			"packages/coding-agent/src/core/export-html/vendor/marked.LICENSE",
			"packages/coding-agent/dist/LICENSES/marked-18.0.5-LICENSE.txt",
		],
	];
	execNpm(["run", "copy-third-party-licenses"], {
		cwd: "packages/coding-agent",
		stdio: "pipe",
	});
	for (const [source, copied] of licenseCopies) {
		assert.deepEqual(readFileSync(copied), readFileSync(source));
	}
	assert.equal(codingAgentManifest.dependencies["@silvia-odwyer/photon-node"], undefined);
	assert.equal(existsSync("packages/coding-agent/src/utils/photon.ts"), false);
	assert.doesNotMatch(JSON.stringify(codingAgentManifest.scripts), /photon|photon_rs|\.wasm/i);
	assert.doesNotMatch(JSON.stringify(codingAgentManifest.scripts), /bun build|dist\/bun/i);
	assert.doesNotMatch(`${buildScript}\n${standaloneBuild}`, /bun build|dist\/bun/i);
	assert.doesNotMatch(
		`${buildScript}\n${standaloneBuild}`,
		/@silvia-odwyer\/photon-node|photon_rs_bg\.wasm/,
	);
	assert.doesNotMatch(
		readFileSync("packages/coding-agent/THIRD-PARTY-NOTICES.md", "utf8"),
		/@silvia-odwyer|photon_rs|Photon/,
	);
	for (const generatedDoomArtifact of [
		"packages/coding-agent/docs/images/doom-extension.png",
		"packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js",
		"packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm",
	]) {
		assert.equal(existsSync(generatedDoomArtifact), false, generatedDoomArtifact);
	}
	const doomBuild = readFileSync("packages/coding-agent/examples/extensions/doom-overlay/doom/build.sh", "utf8");
	assert.match(doomBuild, /DOOMGENERIC_COMMIT="[0-9a-f]{40}"/);
	assert.match(doomBuild, /git -C doomgeneric checkout --detach "\$DOOMGENERIC_COMMIT"/);
	const doomIgnore = readFileSync("packages/coding-agent/examples/extensions/doom-overlay/.gitignore", "utf8");
	assert.match(doomIgnore, /doom\/build\//);
	assert.match(doomIgnore, /doom\/doomgeneric\//);
	assert.doesNotMatch(buildScript, /@mariozechner\/clipboard|clipboard_native_package/);

	const betaReadiness = readFileSync("BETA-READINESS.md", "utf8");
	assert.match(betaReadiness, /not ready for public beta\s+distribution/i);
	assert.match(betaReadiness, /Do not run Approve Release until/i);
	assert.match(betaReadiness, /Prove the npm daemon distribution/);
	assert.match(betaReadiness, /Node\.js 22\.23\.1/);
	assert.match(betaReadiness, /glibc 2\.28/);
	assert.match(betaReadiness, /Windows executables are not\s+Authenticode-signed/);
	assert.match(betaReadiness, /Resolve Doom source-archive provenance/);
});

test("release archive creation is deterministic and rejects symlinks", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-release-archive-test-"));
	try {
		const input = join(directory, "input");
		mkdirSync(join(input, "docs"), { recursive: true });
		writeFileSync(join(input, "volt"), "binary\n", { mode: 0o755 });
		writeFileSync(join(input, "docs", "README.md"), "docs\n");

		for (const format of ["tar.gz", "zip"]) {
			const first = join(directory, `first.${format}`);
			const second = join(directory, `second.${format}`);
			const args = [
				"scripts/create-release-archive.py",
				"--input",
				input,
				"--format",
				format,
				"--epoch",
				"1700000000",
			];
			execPython([...args, "--output", first, ...(format === "tar.gz" ? ["--root", "volt"] : [])]);
			execPython([...args, "--output", second, ...(format === "tar.gz" ? ["--root", "volt"] : [])]);
			assert.deepEqual(readFileSync(first), readFileSync(second));
		}

		for (const unsafeRoot of [".", "..", "../escape", "..\\escape", "C:\\escape"]) {
			const result = spawnPython([
				"scripts/create-release-archive.py",
				"--input",
				input,
				"--output",
				join(directory, "unsafe-root.tar.gz"),
				"--format",
				"tar.gz",
				"--root",
				unsafeRoot,
			]);
			assert.notEqual(result.status, 0, unsafeRoot);
			assert.match(result.stderr.toString(), /one safe relative path component/);
		}

		if (isWindows) {
			const junctionTarget = join(directory, "junction-target");
			mkdirSync(junctionTarget);
			symlinkSync(junctionTarget, join(input, "linked-directory"), "junction");
		} else {
			symlinkSync("volt", join(input, "linked-volt"));
		}
		const result = spawnPython([
			"scripts/create-release-archive.py",
			"--input",
			input,
			"--output",
			join(directory, "unsafe.zip"),
			"--format",
			"zip",
		]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr.toString(), /must not contain symlinks or reparse points/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("binary build refuses destructive output paths before invoking the compiler", () => {
	const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	const result = spawnSync(
		bashShell,
		[
			"scripts/build-binaries.sh",
			"--skip-install",
			"--skip-build",
			"--platform",
			platform,
			"--out",
			".",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /contains the repository/);
	assert.doesNotMatch(readFileSync("scripts/build-binaries.sh", "utf8"), /rm -rf "\$OUTPUT_DIR"(?:\s|$)/);
});

test("Unix npm installer defaults to the beta channel and does not promise daemon support on Darwin x64", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-intel-installer-test-"));
	try {
		const fakeBin = join(directory, "bin");
		const home = join(directory, "home");
		mkdirSync(fakeBin);
		mkdirSync(home);
		const fakeNode = join(fakeBin, "node");
		writeFileSync(
			fakeNode,
			`#!/bin/sh
case "$*" in
  *process.versions.node*) printf '1\\n' ;;
  *process.platform*) printf 'darwin-x64\\n' ;;
  *) exit 1 ;;
esac
`,
		);
		chmodSync(fakeNode, 0o755);
		const fakeNpm = join(fakeBin, "npm");
		writeFileSync(fakeNpm, "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$VOLT_INSTALL_NPM_LOG\"\n");
		chmodSync(fakeNpm, 0o755);
		const fakeVolt = join(fakeBin, "volt");
		writeFileSync(fakeVolt, "#!/bin/sh\nprintf 'volt 1.2.3\\n'\n");
		chmodSync(fakeVolt, 0o755);

		const result = spawnSync(posixShell, ["site/public/install.sh"], {
			encoding: "utf8",
				env: {
					...process.env,
					HOME: home,
					PATH: prependPath(fakeBin),
					VOLT_INSTALL_METHOD: "npm",
					VOLT_INSTALL_NPM_LOG: join(directory, "npm-args.log"),
				},
			});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(join(directory, "npm-args.log"), "utf8").trim(),
			"install -g --ignore-scripts @hansjm10/volt-coding-agent@beta",
		);
		assert.match(result.stdout, /unavailable on Intel macOS/);
		assert.doesNotMatch(result.stdout, /This npm install supports 'volt daemon'/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release notes link to the canonical GitHub repository", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-release-notes-test-"));
	try {
		const changelog = join(directory, "CHANGELOG.md");
		const output = join(directory, "notes.md");
		writeFileSync(changelog, "# Changelog\n\n## [1.2.3] - 2026-07-12\n\nSee [README](README.md).\n");
		execFileSync(process.execPath, [
			"scripts/release-notes.mjs",
			"extract",
			"--version",
			"1.2.3",
			"--changelog",
			changelog,
			"--out",
			output,
		]);
		assert.match(
			readFileSync(output, "utf8"),
			/https:\/\/github\.com\/volt-hq\/Volt\/blob\/v1\.2\.3\/packages\/coding-agent\/README\.md/,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("Unix binary installer verifies a pinned archive before installing its exact executable", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-installer-test-"));
	try {
		const payload = join(directory, "payload");
		const fixtures = join(directory, "fixtures");
		const fakeBin = join(directory, "fake-bin");
		const home = join(directory, "home");
		mkdirSync(payload);
		mkdirSync(fixtures);
		mkdirSync(fakeBin);
		mkdirSync(home);
		writeFileSync(join(payload, "volt"), "#!/bin/sh\nprintf 'fixture volt\\n'\n", { mode: 0o755 });
		for (const directory of ["LICENSES", "theme", "export-html"]) {
			mkdirSync(join(payload, directory));
		}
		for (const file of [
			"package.json",
			"image-resize-worker.cjs",
			"binary-metafile.json",
			"binary-license-manifest.json",
			"standalone-build-manifest.json",
			"standalone-file-manifest.json",
		]) {
			writeFileSync(join(payload, file), `${file}\n`);
		}
		writeFileSync(join(payload, "LICENSES", "node-v22.23.1-LICENSE.txt"), "node license\n");
		writeFileSync(join(payload, "theme", "dark.json"), "{}\n");
		writeFileSync(join(payload, "export-html", "template.html"), "<html></html>\n");
		const asset = "volt-linux-x64.tar.gz";
		const archive = join(fixtures, asset);
		execPython([
			"scripts/create-release-archive.py",
			"--input",
			payload,
			"--output",
			archive,
			"--format",
			"tar.gz",
			"--root",
			"volt",
		]);
		const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
		writeFileSync(join(fixtures, "SHA256SUMS"), `${checksum}  ${asset}\n`);

		const env = {
			...process.env,
			HOME: home,
			PATH: prependPath(fakeBin),
			VOLT_INSTALL_FIXTURES: fixtures,
			VOLT_INSTALL_METHOD: "binary",
			VOLT_INSTALL_URL_LOG: join(directory, "download-urls.log"),
			VOLT_VERSION: "1.2.3",
		};
		const runInstaller = (environment) =>
			spawnSync(
				posixShell,
				[
					"-c",
					`curl() {
    output=""
    url=""
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "-o" ]; then
            output="$2"
            shift 2
        else
            url="$1"
            shift
        fi
    done
    cp "$VOLT_INSTALL_FIXTURES/\${url##*/}" "$output"
    printf '%s\\n' "$url" >> "$VOLT_INSTALL_URL_LOG"
}
uname() {
    [ "$1" = "-s" ] && printf 'Linux\\n' || printf 'x86_64\\n'
}
. site/public/install.sh`,
				],
				{ encoding: "utf8", env: environment },
			);
		const installed = runInstaller(env);
		assert.equal(installed.status, 0, installed.stderr);
		assert.equal(readFileSync(join(home, ".volt", "bin", "volt"), "utf8"), readFileSync(join(payload, "volt"), "utf8"));
		assert.deepEqual(
			readFileSync(join(home, ".volt", "bin", "image-resize-worker.cjs")),
			readFileSync(join(payload, "image-resize-worker.cjs")),
		);
		assert.deepEqual(
			readFileSync(join(home, ".volt", "bin", "LICENSES", "node-v22.23.1-LICENSE.txt")),
			readFileSync(join(payload, "LICENSES", "node-v22.23.1-LICENSE.txt")),
		);
		assert.match(installed.stdout, /Installed verified standalone release/);
		assert.match(readFileSync(env.VOLT_INSTALL_URL_LOG, "utf8"), /\/releases\/download\/v1\.2\.3\/volt-linux-x64\.tar\.gz/);

		writeFileSync(join(fixtures, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);
		const secondHome = join(directory, "unverified-home");
		mkdirSync(secondHome);
		const rejected = runInstaller({ ...env, HOME: secondHome });
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /SHA-256 verification failed/);
		assert.throws(() => readFileSync(join(secondHome, ".volt", "bin", "volt")));

		execPython([
			"-c",
			`import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz") as archive:
    link = tarfile.TarInfo("volt/unsafe-link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/tmp"
    archive.addfile(link)
`,
			archive,
		]);
		const unsafeChecksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
		writeFileSync(join(fixtures, "SHA256SUMS"), `${unsafeChecksum}  ${asset}\n`);
		const unsafeHome = join(directory, "unsafe-home");
		mkdirSync(unsafeHome);
		const unsafe = runInstaller({ ...env, HOME: unsafeHome });
		assert.notEqual(unsafe.status, 0);
		assert.match(unsafe.stderr, /only regular files and directories/);
		assert.equal(existsSync(join(unsafeHome, ".volt", "bin")), false);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("fixture git commands are insulated from a hook's inherited GIT_DIR", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-git-env-scrub-"));
	try {
		const outer = join(directory, "outer");
		const fixture = join(directory, "fixture");
		mkdirSync(outer);
		mkdirSync(fixture);
		execFileSync("git", ["init"], { cwd: outer, stdio: "ignore" });

		// A hook environment: git points every child at the commit's repository.
		const hookEnv = { ...process.env, GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer };

		// Establish the hazard is real rather than hypothetical: inheriting those
		// variables makes an init inside `fixture` operate on `outer` instead, so
		// the fixture never gets a repository of its own.
		execFileSync("git", ["init"], { cwd: fixture, env: hookEnv, stdio: "ignore" });
		assert.equal(
			existsSync(join(fixture, ".git")),
			false,
			"expected an inherited GIT_DIR to retarget the fixture's git init",
		);

		// Scrubbed, the same command builds the fixture's own repository.
		execFileSync("git", ["init"], { cwd: fixture, env: scrubGitRepoScopingEnv({ ...hookEnv }), stdio: "ignore" });
		assert.ok(existsSync(join(fixture, ".git")), "expected the scrubbed env to init the fixture repository");

		// And the suite's own environment carries none of them, so every helper
		// in this file is covered without threading an env through each call.
		for (const name of GIT_REPO_SCOPING_ENV) {
			assert.equal(process.env[name], undefined, `${name} must not leak into fixture commands`);
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
