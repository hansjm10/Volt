import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadOnlyToolDefinitions, createReadOnlyTools, READ_ONLY_TOOL_NAMES } from "../src/core/tools/index.ts";
import {
	createInspectionToolDefinition,
	createLocalInspectionOperations,
	type InspectionOperations,
	type InspectionToolInput,
	resolveInspectionCommand,
} from "../src/core/tools/inspect.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const path = join(tmpdir(), `volt-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(path, { recursive: true });
	tempDirs.push(path);
	return path;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
}

function initializeRepository(cwd: string): void {
	git(cwd, "init", "--quiet");
	git(cwd, "config", "user.email", "volt@example.com");
	git(cwd, "config", "user.name", "Volt Test");
	writeFileSync(join(cwd, "tracked.txt"), "initial\n");
	git(cwd, "add", "--", "tracked.txt");
	git(cwd, "commit", "--quiet", "-m", "initial");
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("inspection tool", () => {
	it("keeps both read-only factories consistent with READ_ONLY_TOOL_NAMES", () => {
		expect(createReadOnlyToolDefinitions(process.cwd()).map((tool) => tool.name)).toEqual(READ_ONLY_TOOL_NAMES);
		expect(createReadOnlyTools(process.cwd()).map((tool) => tool.name)).toEqual(READ_ONLY_TOOL_NAMES);
	});

	it("constructs direct argv for approved Git and GitHub reads", () => {
		const git = resolveInspectionCommand({ operation: "git.log", args: ["--oneline", "-n", "5"] });
		expect(git).toMatchObject({
			executable: "git",
			kind: "workspace-read",
			display: "git log --no-ext-diff --no-textconv --oneline -n 5",
		});
		expect(git.args).toEqual([
			"--no-pager",
			"--no-optional-locks",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.pager=cat",
			"-c",
			"color.ui=false",
			"-c",
			"diff.external=",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"format.pretty=medium",
			"-c",
			"log.showSignature=false",
			"log",
			"--no-ext-diff",
			"--no-textconv",
			"--oneline",
			"-n",
			"5",
		]);

		const github = resolveInspectionCommand({
			operation: "gh.issue.view",
			args: ["123", "--repo", "volt-hq/Volt", "--comments"],
		});
		expect(github).toEqual({
			executable: "gh",
			args: ["issue", "view", "123", "--repo", "volt-hq/Volt", "--comments"],
			kind: "network-read",
			display: "gh issue view 123 --repo volt-hq/Volt --comments",
		});
	});

	it("accepts documented read options, option values, short clusters, and positional separators", () => {
		expect(resolveInspectionCommand({ operation: "git.log", args: ["--oneline", "-20"] }).display).toBe(
			"git log --no-ext-diff --no-textconv --oneline -20",
		);
		expect(resolveInspectionCommand({ operation: "git.log", args: ["-pqn5"] }).display).toContain("-pqn5");
		expect(resolveInspectionCommand({ operation: "git.log", args: ["--max-count=5"] }).display).toContain(
			"--max-count=5",
		);
		expect(resolveInspectionCommand({ operation: "git.log", args: ["--pretty=fuller"] }).display).toContain(
			"--pretty=fuller",
		);
		expect(
			resolveInspectionCommand({ operation: "git.status", args: ["-sb", "--untracked-files=all"] }).display,
		).toBe("git status -sb --untracked-files=all");
		expect(resolveInspectionCommand({ operation: "git.branches", args: ["--", "--no-list"] }).args).toContain(
			"--list",
		);
		expect(resolveInspectionCommand({ operation: "gh.pr.view", args: ["123", "-Rvolt-hq/Volt"] }).args).toContain(
			"-Rvolt-hq/Volt",
		);
		expect(resolveInspectionCommand({ operation: "gh.pr.view", args: ["123", "-q.workflow"] }).args).toContain(
			"-q.workflow",
		);
		expect(resolveInspectionCommand({ operation: "gh.issue.list", args: ["-aw"] }).args).toContain("-aw");
	});

	const unsafeCases: Array<[InspectionToolInput, string]> = [
		[{ operation: "git.diff", args: ["--output=change.patch"] }, "--output=change.patch"],
		[{ operation: "git.diff", args: ["--ext-diff"] }, "--ext-diff"],
		[{ operation: "git.diff", args: ["--textconv"] }, "--textconv"],
		[{ operation: "git.diff", args: ["--no-index", "/etc/passwd", "README.md"] }, "--no-index"],
		[{ operation: "git.log", args: ["--config-env=alias.log:VOLT_ALIAS"] }, "--config-env"],
		[{ operation: "git.log", args: ["--format=%G?"] }, "signature verification"],
		[{ operation: "git.log", args: ["--pretty=repository-alias"] }, "Repository-configured"],
		[{ operation: "git.refs", args: ["--format=%(signature:grade)"] }, "signature verification"],
		[{ operation: "git.branches", args: ["--delete", "main"] }, "--delete"],
		[{ operation: "git.branches", args: ["--no-list", "main"] }, "--no-list"],
		[{ operation: "git.branches", args: ["-df", "main"] }, "-d"],
		[{ operation: "git.tags", args: ["--sign", "v1"] }, "--sign"],
		[{ operation: "git.tags", args: ["--no-list", "v1"] }, "--no-list"],
		[{ operation: "gh.pr.view", args: ["123", "--web"] }, "--web"],
		[{ operation: "gh.issue.view", args: ["123", "-w=true"] }, "-w=true"],
		[{ operation: "gh.pr.view", args: ["123", "-wRcli/cli"] }, "-wRcli/cli"],
		[{ operation: "gh.pr.view", args: ["123", "-cw"] }, "-cw"],
		[{ operation: "gh.pr.view", args: ["123", "-w=true"] }, "-w=true"],
		[{ operation: "gh.search.issues", args: ["bug", "-w=true"] }, "-w=true"],
		[{ operation: "gh.issue.view", args: ["123", ";", "touch", "pwned"] }, "Shell control syntax"],
		[{ operation: "gh.search.issues", args: ["bug\ntouch pwned"] }, "single-line"],
	];

	it.each(unsafeCases)("rejects unsafe arguments %#", (input, message) => {
		expect(() => resolveInspectionCommand(input)).toThrow(message);
	});

	it("keeps branch and tag operations in listing mode when mutation flags are clustered or negated", async () => {
		const cwd = makeTempDir();
		initializeRepository(cwd);
		git(cwd, "branch", "victim");
		git(cwd, "tag", "victim-tag");
		const tool = createInspectionToolDefinition(cwd);

		await expect(
			tool.execute(
				"inspect-branch-delete",
				{ operation: "git.branches", args: ["--no-list", "-df", "victim"] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("--no-list");
		await expect(
			tool.execute(
				"inspect-tag-delete",
				{ operation: "git.tags", args: ["--no-list", "-d", "victim-tag"] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("--no-list");

		expect(git(cwd, "show-ref", "--verify", "refs/heads/victim")).toContain("refs/heads/victim");
		expect(git(cwd, "show-ref", "--verify", "refs/tags/victim-tag")).toContain("refs/tags/victim-tag");
	});

	it.skipIf(process.platform === "win32")(
		"disables repository-configured fsmonitor, textconv, clean, and process helpers",
		async () => {
			const cwd = makeTempDir();
			initializeRepository(cwd);
			const fsmonitorMarker = join(cwd, "fsmonitor-ran");
			const fsmonitorHelper = join(cwd, "fsmonitor-helper");
			writeFileSync(
				fsmonitorHelper,
				`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "ran");\nprocess.stdout.write("token\\n");\n`,
			);
			chmodSync(fsmonitorHelper, 0o755);
			git(cwd, "config", "core.fsmonitor", fsmonitorHelper);
			git(cwd, "status", "--short");
			expect(existsSync(fsmonitorMarker)).toBe(true);
			rmSync(fsmonitorMarker);

			const tool = createInspectionToolDefinition(cwd);
			await tool.execute(
				"inspect-status",
				{ operation: "git.status", args: ["--short"] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(existsSync(fsmonitorMarker)).toBe(false);
			git(cwd, "config", "--unset", "core.fsmonitor");

			const textconvMarker = join(cwd, "textconv-ran");
			const textconvHelper = join(cwd, "textconv-helper");
			writeFileSync(
				textconvHelper,
				`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(textconvMarker)}, "ran");\nprocess.stdout.write("converted\\n");\n`,
			);
			chmodSync(textconvHelper, 0o755);
			writeFileSync(join(cwd, ".gitattributes"), "tracked.txt diff=unsafe\n");
			git(cwd, "add", "--", ".gitattributes");
			git(cwd, "commit", "--quiet", "-m", "add attributes");
			git(cwd, "config", "diff.unsafe.textconv", textconvHelper);
			writeFileSync(join(cwd, "tracked.txt"), "changed\n");
			git(cwd, "diff", "--textconv");
			expect(existsSync(textconvMarker)).toBe(true);
			rmSync(textconvMarker);

			await tool.execute("inspect-diff", { operation: "git.diff" }, undefined, undefined, undefined as never);
			expect(existsSync(textconvMarker)).toBe(false);

			const cleanMarker = join(cwd, "clean-ran");
			const cleanHelper = join(cwd, "clean-helper");
			writeFileSync(
				cleanHelper,
				`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(cleanMarker)}, "ran");\nprocess.stdin.pipe(process.stdout);\n`,
			);
			chmodSync(cleanHelper, 0o755);
			writeFileSync(join(cwd, "clean.txt"), "initial\n");
			writeFileSync(join(cwd, ".gitattributes"), "tracked.txt diff=unsafe\nclean.txt filter=unsafe-clean\n");
			git(cwd, "add", "--", ".gitattributes", "clean.txt");
			git(cwd, "commit", "--quiet", "-m", "add clean filter target");
			git(cwd, "config", "filter.unsafe-clean.clean", cleanHelper);
			git(cwd, "config", "filter.unsafe-clean.required", "true");
			writeFileSync(join(cwd, "clean.txt"), "changed\n");
			git(cwd, "status", "--short");
			expect(existsSync(cleanMarker)).toBe(true);
			rmSync(cleanMarker);

			await tool.execute(
				"inspect-clean-filter",
				{ operation: "git.status", args: ["--short"] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(existsSync(cleanMarker)).toBe(false);
			git(cwd, "config", "--unset", "filter.unsafe-clean.clean");
			git(cwd, "config", "--unset", "filter.unsafe-clean.required");

			const processMarker = join(cwd, "process-ran");
			const processHelper = join(cwd, "process-helper");
			writeFileSync(
				processHelper,
				`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(processMarker)}, "ran");\nprocess.exit(1);\n`,
			);
			chmodSync(processHelper, 0o755);
			writeFileSync(join(cwd, "process.txt"), "initial\n");
			writeFileSync(
				join(cwd, ".gitattributes"),
				"tracked.txt diff=unsafe\nclean.txt filter=unsafe-clean\nprocess.txt filter=unsafe-process\n",
			);
			git(cwd, "add", "--", ".gitattributes", "process.txt");
			git(cwd, "commit", "--quiet", "-m", "add process filter target");
			git(cwd, "config", "filter.unsafe-process.process", processHelper);
			git(cwd, "config", "filter.unsafe-process.required", "true");
			writeFileSync(join(cwd, "process.txt"), "changed\n");
			try {
				git(cwd, "status", "--short");
			} catch {
				// A required process filter that exits during negotiation can fail the unprotected status read.
			}
			expect(existsSync(processMarker)).toBe(true);
			rmSync(processMarker);

			await tool.execute(
				"inspect-process-filter",
				{ operation: "git.status", args: ["--short"] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(existsSync(processMarker)).toBe(false);
		},
	);

	it("passes arguments literally, constrains the environment, and bounds output", async () => {
		const cwd = makeTempDir();
		let invocation:
			| { executable: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; timeout: number }
			| undefined;
		const operations: InspectionOperations = {
			exec: async (executable, args, workingDirectory, options) => {
				invocation = { executable, args, cwd: workingDirectory, env: options.env, timeout: options.timeout };
				options.onData(Buffer.from(`${Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n")}\n`));
				return { exitCode: 0 };
			},
		};
		const tool = createInspectionToolDefinition(cwd, { operations });
		const result = await tool.execute(
			"inspect-1",
			{ operation: "gh.search.issues", args: ["bug; touch pwned"], timeout: 20 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(invocation).toMatchObject({
			executable: "gh",
			args: ["search", "issues", "bug; touch pwned"],
			cwd,
			timeout: 20,
			env: {
				GIT_NO_LAZY_FETCH: "1",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_PAGER: "cat",
				GIT_TERMINAL_PROMPT: "0",
				GH_PAGER: "cat",
				GH_PROMPT_DISABLED: "1",
				PAGER: "cat",
			},
		});
		expect(result.details?.truncation).toMatchObject({ truncated: true, totalLines: 2_100, outputLines: 2_000 });
		expect(result.details?.fullOutputPath).toContain("volt-inspect-");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Full output:") });
	});

	it("propagates aborts and terminates the direct child process", async () => {
		const cwd = makeTempDir();
		const operations = createLocalInspectionOperations();
		const controller = new AbortController();
		const running = operations.exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], cwd, {
			onData: () => undefined,
			signal: controller.signal,
			timeout: 10,
			env: process.env,
		});
		setTimeout(() => controller.abort(), 50);
		await expect(running).rejects.toThrow("aborted");
	});

	it("reports nonzero exits without treating output as success", async () => {
		const cwd = makeTempDir();
		const tool = createInspectionToolDefinition(cwd, {
			operations: {
				exec: async (_executable, _args, _workingDirectory, options) => {
					options.onData(Buffer.from("not found\n"));
					return { exitCode: 1 };
				},
			},
		});
		await expect(
			tool.execute(
				"inspect-fail",
				{ operation: "gh.issue.view", args: ["404"] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("not found\n\nInspection exited with code 1");
	});
});
