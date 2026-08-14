import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	buildDockerCreateArgs,
	buildEvaluatorArgs,
	buildPrompt,
	buildVoltExecArgs,
	CleanupStack,
	collectCredentialSecrets,
	CommandError,
	createPrediction,
	DEFAULT_INSTANCE,
	DEFAULT_THINKING,
	DEFAULT_TIMEOUT_SECONDS,
	isolateCodexAuth,
	parseArgs,
	parseInstanceMetadata,
	redactText,
	runBenchmark,
	SWEBENCH_DATASET,
	SWEBENCH_REVISION,
} from "./benchmark-swebench.mjs";

const temporaryDirectories = new Set();
const ACCESS_TOKEN = "access-token-that-must-never-leak";
const REFRESH_TOKEN = "refresh-token-that-must-never-leak";
const INITIAL_HEAD = "0123456789abcdef0123456789abcdef01234567";
const PATCH = "diff --git a/example.py b/example.py\n--- a/example.py\n+++ b/example.py\n@@ -1 +1 @@\n-old\n+new\n";

async function createTemporaryDirectory(prefix = "volt-swebench-test-") {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.add(directory);
	return directory;
}

async function createFixture() {
	const root = await createTemporaryDirectory();
	const voltDir = join(root, "volt-linux-x64");
	const authFile = join(root, "auth.json");
	const outputDir = join(root, "output");
	await mkdir(voltDir);
	await writeFile(join(voltDir, "volt"), "#!/bin/sh\n", { mode: 0o755 });
	await chmod(join(voltDir, "volt"), 0o755);
	await writeFile(
		authFile,
		`${JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: ACCESS_TOKEN,
				refresh: REFRESH_TOKEN,
				expires: 4_000_000_000_000,
				accountId: "account-id-that-is-private",
			},
			anthropic: { type: "api_key", key: "unrelated-provider-secret" },
		})}\n`,
		{ mode: 0o600 },
	);
	return {
		root,
		voltDir,
		authFile,
		outputDir,
		options: {
			help: false,
			voltDir,
			model: "openai-codex/gpt-5.6-sol",
			instance: DEFAULT_INSTANCE,
			thinking: DEFAULT_THINKING,
			timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			authFile,
			python: "python3",
			runId: "volt-swebench-test-run",
			outputDir,
		},
	};
}

function commandResult(stdout = "", stderr = "", code = 0) {
	return { code, signal: null, stdout, stderr, timedOut: false, aborted: false };
}

function argumentAfter(args, flag) {
	const index = args.indexOf(flag);
	assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(args)}`);
	return args[index + 1];
}

function createSuccessfulCommandFake(fixture, options = {}) {
	const calls = [];
	let temporaryAuthDir;
	const command = async (executable, args, commandOptions = {}) => {
		calls.push({ executable, args: [...args], options: { ...commandOptions } });
		if (executable === fixture.options.python && args[0] === "-c" && args.length === 2) {
			return commandResult("swebench-ok\n");
		}
		if (executable === fixture.options.python && args[0] === "-c" && args[2] === DEFAULT_INSTANCE) {
			assert.match(args[1], /\("instance_id", "image", "problem_statement"\)/);
			assert.doesNotMatch(args[1], /test_patch/);
			return commandResult(
				`${JSON.stringify({
					instance_id: DEFAULT_INSTANCE,
					image: "swebench/sweb.eval.x86_64.sympy__sympy-20590:latest",
					problem_statement: "Fix the public behavior. GOLD_PATCH_SENTINEL must stay hidden.",
				})}\n`,
			);
		}
		if (executable === fixture.options.python && args[0] === "-m") {
			const reportDir = argumentAfter(args, "--report_dir");
			await mkdir(reportDir, { recursive: true });
			await writeFile(
				join(reportDir, "official-report.json"),
				options.malformedReport ? "not json" : JSON.stringify({ resolved: options.resolved ?? false }),
			);
			return commandResult("evaluation complete\n");
		}
		if (executable === join(fixture.voltDir, "volt")) return commandResult("0.1.0\n");
		if (executable !== "docker") throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
		if (args[0] === "version") return commandResult("27.0.0\n");
		if (args[0] === "image" && args[1] === "inspect") return commandResult("[]\n");
		if (args[0] === "create") {
			const authMount = args.find((argument) => argument.startsWith("type=bind,src=") && argument.endsWith(",dst=/volt-agent"));
			assert.ok(authMount);
			temporaryAuthDir = authMount.slice("type=bind,src=".length, -",dst=/volt-agent".length);
			const staged = JSON.parse(await readFile(join(temporaryAuthDir, "auth.json"), "utf8"));
			assert.deepEqual(Object.keys(staged), ["openai-codex"]);
			assert.equal(staged["openai-codex"].access, ACCESS_TOKEN);
			return commandResult("container-id\n");
		}
		if (args[0] === "start") return commandResult(`${args[1]}\n`);
		if (args[0] === "rm") return commandResult();
		if (args[0] === "exec" && args.includes("status")) return commandResult();
		if (args[0] === "exec" && args.includes("rev-parse")) return commandResult(`${INITIAL_HEAD}\n`);
		if (args[0] === "exec" && args.includes("/opt/volt/volt")) {
			if (options.voltError) {
				throw new CommandError("Volt timed out", {
					code: 143,
					signal: "SIGTERM",
					stdout: `partial ${ACCESS_TOKEN}\n`,
					stderr: `refresh ${REFRESH_TOKEN}\n`,
					timedOut: true,
					aborted: false,
				});
			}
			return commandResult(`completed ${ACCESS_TOKEN}\n`, `diagnostic ${REFRESH_TOKEN}\n`);
		}
		if (args[0] === "exec" && args.includes("add")) return commandResult();
		if (args[0] === "exec" && args.includes("diff")) return commandResult(PATCH);
		throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
	};
	return { calls, command, getTemporaryAuthDir: () => temporaryAuthDir };
}

afterEach(async () => {
	await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.clear();
});

describe("SWE-bench argument and data boundaries", () => {
	it("pins the official harness requirement to the approved revision", async () => {
		const requirements = await readFile(new URL("./requirements-swebench.txt", import.meta.url), "utf8");
		assert.equal(
			requirements,
			`swebench @ git+https://github.com/SWE-bench/SWE-bench.git@${SWEBENCH_REVISION}\n`,
		);
	});

	it("uses the approved defaults and requires an exact Codex model", () => {
		const parsed = parseArgs(
			["--volt-dir", "./standalone", "--model", "openai-codex/gpt-5.6-sol"],
			{
				cwd: "/repo",
				home: "/home/volt",
				now: new Date("2026-08-14T12:34:56.000Z"),
				suffix: "abc123",
			},
		);
		assert.equal(parsed.instance, DEFAULT_INSTANCE);
		assert.equal(parsed.thinking, DEFAULT_THINKING);
		assert.equal(parsed.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
		assert.equal(parsed.python, "python3");
		assert.equal(parsed.authFile, join("/home/volt", ".volt", "agent", "auth.json"));
		assert.match(parsed.outputDir, /swebench-output/);
		assert.throws(
			() => parseArgs(["--volt-dir", "./standalone", "--model", "openai/gpt-5.6-sol"]),
			/openai-codex/,
		);
		assert.throws(
			() => parseArgs(["--volt-dir", "./standalone", "--model", "openai-codex/gpt-5.6-sol", "--api-key", "x"]),
			/Unknown option: --api-key/,
		);
	});

	it("accepts only the three public metadata fields", () => {
		const metadata = parseInstanceMetadata(
			JSON.stringify({
				instance_id: DEFAULT_INSTANCE,
				image: "swebench/example:latest",
				problem_statement: "Fix it",
			}),
			DEFAULT_INSTANCE,
		);
		assert.deepEqual(metadata, {
			instanceId: DEFAULT_INSTANCE,
			image: "swebench/example:latest",
			problemStatement: "Fix it",
		});
		assert.throws(
			() =>
				parseInstanceMetadata(
					JSON.stringify({
						instance_id: DEFAULT_INSTANCE,
						image: "swebench/example:latest",
						problem_statement: "Fix it",
						test_patch: "hidden",
					}),
					DEFAULT_INSTANCE,
				),
			/fields must be exactly/,
		);
	});

	it("builds an issue-only implementation prompt", () => {
		const prompt = buildPrompt("Observable issue text");
		assert.match(prompt, /Observable issue text/);
		assert.match(prompt, /Modify the working tree/);
		assert.doesNotMatch(prompt, /test_patch|FAIL_TO_PASS|PASS_TO_PASS|gold solution/i);
	});

	it("isolates only OAuth Codex auth and redacts every private string", () => {
		const isolated = isolateCodexAuth({
			"openai-codex": {
				type: "oauth",
				access: ACCESS_TOKEN,
				refresh: REFRESH_TOKEN,
				expires: 123,
				accountId: "private-account-id",
			},
			openai: { type: "api_key", key: "other-secret" },
		});
		assert.deepEqual(Object.keys(isolated), ["openai-codex"]);
		const secrets = collectCredentialSecrets(isolated);
		const redacted = redactText(`${ACCESS_TOKEN} ${REFRESH_TOKEN} private-account-id`, secrets);
		assert.equal(redacted, "[REDACTED] [REDACTED] [REDACTED]");
		assert.throws(
			() => isolateCodexAuth({ "openai-codex": { type: "api_key", key: "not-oauth" } }),
			/OAuth credential/,
		);
	});
});

describe("SWE-bench command contracts", () => {
	it("constructs the constrained container and Volt invocations", () => {
		const createArgs = buildDockerCreateArgs({
			containerName: "container-name",
			image: "swebench/example:latest",
			voltDir: "/opt/input/volt",
			authDir: "/tmp/auth",
			outputDir: "/tmp/output",
		});
		assert.deepEqual(createArgs.slice(0, 8), [
			"create",
			"--name",
			"container-name",
			"--user",
			"root",
			"--cap-add",
			"SYS_ADMIN",
			"--mount",
		]);
		assert.ok(createArgs.includes("type=bind,src=/opt/input/volt,dst=/opt/volt,readonly"));
		assert.ok(createArgs.includes("type=bind,src=/tmp/auth,dst=/volt-agent"));
		assert.ok(createArgs.includes("type=bind,src=/tmp/output,dst=/volt-run,readonly"));

		const voltArgs = buildVoltExecArgs({
			containerName: "container-name",
			model: "openai-codex/gpt-5.6-sol",
			thinking: "high",
		});
		assert.ok(voltArgs.includes("--no-session"));
		assert.ok(voltArgs.includes("--no-context-files"));
		assert.ok(voltArgs.includes("--no-extensions"));
		assert.ok(voltArgs.includes("--tools"));
		assert.equal(voltArgs[voltArgs.indexOf("--tools") + 1], "read,bash,edit,write,grep,find,ls");
		assert.equal(voltArgs[voltArgs.indexOf("--model") + 1], "openai-codex/gpt-5.6-sol");
		for (const excluded of ["web_search", "web_fetch", "inspect", "subagent", "image_gen"]) {
			assert.ok(!voltArgs.includes(excluded));
		}
	});

	it("constructs a one-worker, one-instance official evaluator command", () => {
		const args = buildEvaluatorArgs({
			predictionsPath: "/out/predictions.jsonl",
			runId: "run-id",
			instanceId: DEFAULT_INSTANCE,
			reportDir: "/out/evaluation",
		});
		assert.equal(argumentAfter(args, "--dataset_name"), SWEBENCH_DATASET);
		assert.equal(argumentAfter(args, "--max_workers"), "1");
		assert.equal(argumentAfter(args, "--instance_ids"), DEFAULT_INSTANCE);
		assert.equal(argumentAfter(args, "--run_id"), "run-id");
	});

	it("formats the official prediction record", () => {
		assert.deepEqual(createPrediction(DEFAULT_INSTANCE, "openai-codex/gpt-5.6-sol", PATCH), {
			instance_id: DEFAULT_INSTANCE,
			model_name_or_path: "volt-openai-codex-gpt-5.6-sol",
			model_patch: PATCH,
		});
	});
});

describe("SWE-bench lifecycle", () => {
	it("captures the patch from initial image HEAD and accepts an unresolved report", async () => {
		const fixture = await createFixture();
		const fake = createSuccessfulCommandFake(fixture, { resolved: false });
		const result = await runBenchmark(fixture.options, {
			runCommand: fake.command,
			platform: "linux",
			arch: "x64",
		});
		assert.equal(await readFile(result.patchPath, "utf8"), PATCH);
		const prediction = JSON.parse((await readFile(result.predictionsPath, "utf8")).trim());
		assert.equal(prediction.model_patch, PATCH);
		const prompt = await readFile(join(fixture.outputDir, "prompt.md"), "utf8");
		assert.match(prompt, /Fix the public behavior/);
		assert.doesNotMatch(prompt, /test_patch|FAIL_TO_PASS|PASS_TO_PASS/);
		const stdout = await readFile(join(fixture.outputDir, "volt.stdout.log"), "utf8");
		const stderr = await readFile(join(fixture.outputDir, "volt.stderr.log"), "utf8");
		assert.doesNotMatch(stdout, new RegExp(ACCESS_TOKEN));
		assert.doesNotMatch(stderr, new RegExp(REFRESH_TOKEN));
		assert.match(stdout, /\[REDACTED\]/);
		assert.match(stderr, /\[REDACTED\]/);

		const diffCall = fake.calls.find((call) => call.executable === "docker" && call.args.includes("diff"));
		assert.ok(diffCall);
		assert.ok(diffCall.args.includes("--cached"));
		assert.ok(diffCall.args.includes("--binary"));
		assert.ok(diffCall.args.includes(INITIAL_HEAD));
		const addCallIndex = fake.calls.findIndex((call) => call.executable === "docker" && call.args.includes("add"));
		const diffCallIndex = fake.calls.indexOf(diffCall);
		assert.ok(addCallIndex >= 0 && addCallIndex < diffCallIndex);
		assert.ok(fake.calls.some((call) => call.executable === "docker" && call.args[0] === "rm"));
		await assert.rejects(access(fake.getTemporaryAuthDir(), fsConstants.F_OK));
	});

	it("writes partial redacted logs and cleans up when Volt times out", async () => {
		const fixture = await createFixture();
		const fake = createSuccessfulCommandFake(fixture, { voltError: true });
		await assert.rejects(
			runBenchmark(fixture.options, {
				runCommand: fake.command,
				platform: "linux",
				arch: "x64",
			}),
			/timed out/,
		);
		assert.ok(fake.calls.some((call) => call.executable === "docker" && call.args[0] === "rm"));
		await assert.rejects(access(fake.getTemporaryAuthDir(), fsConstants.F_OK));
		const stdout = await readFile(join(fixture.outputDir, "volt.stdout.log"), "utf8");
		const stderr = await readFile(join(fixture.outputDir, "volt.stderr.log"), "utf8");
		assert.equal(stdout, "partial [REDACTED]\n");
		assert.equal(stderr, "refresh [REDACTED]\n");
		assert.ok(!fake.calls.some((call) => call.executable === fixture.options.python && call.args[0] === "-m"));
	});

	it("runs cleanup tasks once in reverse order and reports cleanup failures", async () => {
		const order = [];
		const cleanup = new CleanupStack();
		cleanup.add("first", () => order.push("first"));
		cleanup.add("second", () => order.push("second"));
		await cleanup.run();
		await cleanup.run();
		assert.deepEqual(order, ["second", "first"]);

		const failing = new CleanupStack();
		failing.add("broken", () => {
			throw new Error("failure");
		});
		await assert.rejects(failing.run(), /SWE-bench cleanup failed/);
	});

	it("rejects a dirty initial image and still removes its container and auth", async () => {
		const fixture = await createFixture();
		const fake = createSuccessfulCommandFake(fixture);
		const command = async (executable, args, options) => {
			if (executable === "docker" && args[0] === "exec" && args.includes("status")) {
				fake.calls.push({ executable, args: [...args], options: { ...options } });
				return commandResult(" M preexisting.py\n");
			}
			return fake.command(executable, args, options);
		};
		await assert.rejects(
			runBenchmark(fixture.options, { runCommand: command, platform: "linux", arch: "x64" }),
			/not clean/,
		);
		assert.ok(fake.calls.some((call) => call.executable === "docker" && call.args[0] === "rm"));
		await assert.rejects(access(fake.getTemporaryAuthDir(), fsConstants.F_OK));
	});

	it("requires the evaluator to produce a JSON report", async () => {
		const fixture = await createFixture();
		const fake = createSuccessfulCommandFake(fixture);
		const command = async (executable, args, options) => {
			if (executable === fixture.options.python && args[0] === "-m") return commandResult("no report\n");
			return fake.command(executable, args, options);
		};
		await assert.rejects(
			runBenchmark(fixture.options, { runCommand: command, platform: "linux", arch: "x64" }),
			/without writing a JSON report/,
		);
	});

	it("rejects a malformed evaluator report", async () => {
		const fixture = await createFixture();
		const fake = createSuccessfulCommandFake(fixture, { malformedReport: true });
		await assert.rejects(
			runBenchmark(fixture.options, { runCommand: fake.command, platform: "linux", arch: "x64" }),
			/malformed JSON/,
		);
	});
});
