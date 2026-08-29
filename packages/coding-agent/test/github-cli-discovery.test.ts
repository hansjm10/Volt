import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitHubCli } from "../src/core/code-host/github-cli.ts";
import {
	canonicalizeGitHubRemoteUrl,
	discoverPullRequestWithGitHubCli,
} from "../src/core/code-host/github-cli-discovery.ts";

const OID = "0123456789abcdef0123456789abcdef01234567";
const OTHER_OID = "abcdef0123456789abcdef0123456789abcdef01";
const originalEnvironment = { ...process.env };
const tempDirectories: string[] = [];

function tempDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${label}-`));
	tempDirectories.push(directory);
	return directory;
}

function installFakeCommands(): { captureFile: string } {
	const directory = tempDirectory("work-discovery-bin");
	const captureFile = join(tempDirectory("work-discovery-capture"), "calls.jsonl");
	const gitFixture = join(directory, "git.mjs");
	const ghFixture = join(directory, "gh.mjs");
	writeFileSync(
		gitFixture,
		`import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.VOLT_TEST_CAPTURE, JSON.stringify({ command: "git", args, env: { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_DIR: process.env.GIT_DIR } }) + "\\n");
const remotes = JSON.parse(process.env.VOLT_TEST_REMOTES_JSON || "{}");
if (args[0] === "remote" && args.length === 1) {
  process.stdout.write(Object.keys(remotes).join("\\n") + "\\n");
} else if (args[0] === "remote" && args[1] === "get-url") {
  const values = remotes[args.at(-1)] || [];
  process.stdout.write(values.join("\\n") + (values.length ? "\\n" : ""));
} else if (args[0] === "rev-parse") {
  const upstream = process.env.VOLT_TEST_UPSTREAM || "";
  if (upstream) process.stdout.write(upstream + "\\n");
  else process.exitCode = 1;
} else if (args[0] === "for-each-ref") {
  process.stdout.write(process.env.VOLT_TEST_REMOTE_REFS || "");
} else {
  process.exitCode = 1;
}
`,
	);
	writeFileSync(
		ghFixture,
		`import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
appendFileSync(process.env.VOLT_TEST_CAPTURE, JSON.stringify({ command: "gh", args, env: { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST, GH_DEBUG: process.env.GH_DEBUG, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED, GH_PAGER: process.env.GH_PAGER, GH_NO_UPDATE_NOTIFIER: process.env.GH_NO_UPDATE_NOTIFIER } }) + "\\n");
const mode = process.env.VOLT_TEST_GH_MODE || "responses";
if (mode === "hang") {
  await delay(60_000);
} else if (mode === "oversized") {
  process.stdout.write("x".repeat(300_000));
} else if (mode === "malformed") {
  process.stdout.write("{not json");
} else {
  const repoIndex = args.indexOf("--repo");
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : "";
  const responses = JSON.parse(process.env.VOLT_TEST_GH_RESPONSES || "{}");
  const response = responses[repo] ?? [];
  if (response && typeof response === "object" && !Array.isArray(response) && response.error) {
    process.stderr.write(response.error);
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify(response));
  }
}
`,
	);
	for (const name of ["git", "gh"] as const) {
		const fixture = name === "git" ? gitFixture : ghFixture;
		if (process.platform === "win32") {
			writeFileSync(join(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
		} else {
			const executable = join(directory, name);
			writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
			chmodSync(executable, 0o755);
		}
	}
	process.env.PATH = `${directory}${delimiter}${originalEnvironment.PATH ?? ""}`;
	process.env.VOLT_TEST_CAPTURE = captureFile;
	return { captureFile };
}

function pullRequest(
	number: number,
	overrides: Partial<{
		title: string;
		state: string;
		isDraft: boolean;
		headRefName: string;
		headRefOid: string;
		headOwner: string;
		headRepository: string;
	}> = {},
): Record<string, unknown> {
	return {
		number,
		title: overrides.title ?? `Pull request ${number}`,
		state: overrides.state ?? "OPEN",
		isDraft: overrides.isDraft ?? false,
		headRefName: overrides.headRefName ?? "feature/work",
		headRefOid: overrides.headRefOid ?? OID,
		headRepository: { name: overrides.headRepository ?? "fork" },
		headRepositoryOwner: { login: overrides.headOwner ?? "contributor" },
	};
}

function setRepositoryFixture(): void {
	process.env.VOLT_TEST_REMOTES_JSON = JSON.stringify({
		origin: ["https://github.com/contributor/fork.git"],
		upstream: ["git@github.com:volt-hq/volt.git"],
	});
	process.env.VOLT_TEST_UPSTREAM = "origin/feature/work";
	process.env.VOLT_TEST_REMOTE_REFS = "";
}

function setResponses(responses: Record<string, unknown>): void {
	process.env.VOLT_TEST_GH_MODE = "responses";
	process.env.VOLT_TEST_GH_RESPONSES = JSON.stringify(responses);
}

function calls(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	installFakeCommands();
	setRepositoryFixture();
	setResponses({});
});

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnvironment)) delete process.env[key];
	}
	Object.assign(process.env, originalEnvironment);
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("GitHub remote canonicalization", () => {
	it("accepts credential-free GitHub and GHES remote forms", () => {
		expect(canonicalizeGitHubRemoteUrl("git@github.com:Volt-HQ/Volt.git")).toMatchObject({
			host: "github.com",
			owner: "volt-hq",
			name: "volt",
		});
		expect(canonicalizeGitHubRemoteUrl("ssh://git@git.example.test/Team/Repo.git")).toMatchObject({
			host: "git.example.test",
			owner: "team",
			name: "repo",
		});
		expect(canonicalizeGitHubRemoteUrl("https://token@example.test/team/repo.git")).toBeNull();
		expect(canonicalizeGitHubRemoteUrl("https://example.test/nested/team/repo.git")).toBeNull();
	});
});

describe("exact GitHub pull request discovery", () => {
	it("matches fork repository, branch, and OID while ignoring duplicate branch names and stale heads", async () => {
		setResponses({
			"contributor/fork": [],
			"volt-hq/volt": [
				pullRequest(10, { headOwner: "someone-else", headRepository: "other-fork" }),
				pullRequest(11, { headRefOid: OTHER_OID }),
				pullRequest(12, { title: "Exact fork match" }),
			],
		});

		const outcome = await discoverPullRequestWithGitHubCli({
			cwd: tempDirectory("discovery-cwd"),
			branch: "feature/work",
			headOid: OID,
		});
		expect(outcome).toMatchObject({
			state: "resolved",
			pullRequest: {
				number: 12,
				title: "Exact fork match",
				status: "open",
				headRepository: { canonicalId: "github:github.com/contributor/fork" },
			},
		});
	});

	it("prefers one active PR over historical matches and never guesses among duplicates", async () => {
		setResponses({
			"contributor/fork": [pullRequest(3, { state: "MERGED" })],
			"volt-hq/volt": [pullRequest(4, { isDraft: true })],
		});
		expect(
			await discoverPullRequestWithGitHubCli({ cwd: tempDirectory("active"), branch: "feature/work", headOid: OID }),
		).toMatchObject({ state: "resolved", pullRequest: { number: 4, status: "draft" } });

		setResponses({
			"contributor/fork": [pullRequest(5)],
			"volt-hq/volt": [pullRequest(6)],
		});
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("ambiguous"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "ambiguous" });
	});

	it("resolves one historical PR, reports multiple historical PRs as ambiguous, and preserves none", async () => {
		setResponses({ "volt-hq/volt": [pullRequest(20, { state: "CLOSED" })] });
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("historical"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toMatchObject({ state: "resolved", pullRequest: { number: 20, status: "closed" } });

		setResponses({
			"contributor/fork": [pullRequest(21, { state: "MERGED" })],
			"volt-hq/volt": [pullRequest(22, { state: "CLOSED" })],
		});
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("historical-many"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "ambiguous" });

		setResponses({});
		expect(
			await discoverPullRequestWithGitHubCli({ cwd: tempDirectory("none"), branch: "feature/work", headOid: OID }),
		).toEqual({ state: "none" });
	});

	it.each([
		["authentication required; run gh auth login", "not_authenticated"],
		["API rate limit exceeded", "rate_limited"],
		["network connection failed", "network"],
	])("keeps provider failure distinct from no PR: %s", async (error, reason) => {
		setResponses({
			"contributor/fork": [],
			"volt-hq/volt": { error },
		});
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("provider-error"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "unavailable", reason });
	});

	it("rejects malformed and oversized provider output", async () => {
		process.env.VOLT_TEST_GH_MODE = "malformed";
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("malformed"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "unavailable", reason: "invalid_response" });

		process.env.VOLT_TEST_GH_MODE = "oversized";
		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("oversized"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "unavailable", reason: "output_limited" });
	});

	it("uses explicit repositories and suppresses environment poisoning", async () => {
		const captureFile = process.env.VOLT_TEST_CAPTURE!;
		process.env.GH_REPO = "attacker/override";
		process.env.GH_HOST = "attacker.invalid";
		process.env.GH_DEBUG = "api";
		process.env.GH_CONFIG_DIR = "/tmp/attacker-config";
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
		process.env.GIT_DIR = "/tmp/attacker-git";
		setResponses({});

		expect(
			await discoverPullRequestWithGitHubCli({
				cwd: tempDirectory("environment"),
				branch: "feature/work",
				headOid: OID,
			}),
		).toEqual({ state: "none" });
		const captured = calls(captureFile);
		const gitCalls = captured.filter((call) => call.command === "git");
		const ghCalls = captured.filter((call) => call.command === "gh");
		expect(gitCalls.length).toBeGreaterThan(0);
		expect(gitCalls.every((call) => JSON.stringify(call.env) === "{}")).toBe(true);
		expect(ghCalls).toHaveLength(2);
		for (const call of ghCalls) {
			expect(call.args).toEqual(expect.arrayContaining(["--repo"]));
			expect(call.env).toEqual({
				GH_PROMPT_DISABLED: "1",
				GH_PAGER: "cat",
				GH_NO_UPDATE_NOTIFIER: "1",
			});
		}
	});
});

describe("runGitHubCli bounds", () => {
	it("times out and supports cancellation without returning captured output", async () => {
		process.env.VOLT_TEST_GH_MODE = "hang";
		const timedOut = await runGitHubCli(["pr", "list", "--repo", "volt-hq/volt"], {
			cwd: tempDirectory("gh-timeout"),
			timeoutMs: 25,
		});
		expect(timedOut).toMatchObject({ ok: false, timedOut: true, outputLimited: false });
		expect(timedOut.stdout).toHaveLength(0);

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 25);
		await expect(
			runGitHubCli(["pr", "list", "--repo", "volt-hq/volt"], {
				cwd: tempDirectory("gh-cancel"),
				signal: controller.signal,
				timeoutMs: 1000,
			}),
		).rejects.toThrow("cancelled");
	});
});
