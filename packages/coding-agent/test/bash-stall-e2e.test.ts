/**
 * End-to-end stall detection (#125).
 *
 * The other tests for this change exercise the bash tool and the process
 * teardown in isolation. This one drives the whole path a real run takes — a
 * model emitting a bash tool call, the agent loop executing it, stall detection
 * killing it, and the teardown reaping the tree — and then asserts the two
 * things that actually went wrong in the incident:
 *
 *   1. the model is told the command hung, rather than being left waiting, and
 *   2. no process outlives the command.
 *
 * A faux provider stands in for the model so this runs offline in CI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const isPosix = process.platform !== "win32";
const hasPerl = (() => {
	if (!isPosix) return false;
	try {
		execFileSync("perl", ["-e", "1"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

/** Distinctive duration so the probe never collides with a real process. */
const MARKER = "4761";

function survivors(): number[] {
	try {
		const out = execFileSync("pgrep", ["-f", `sleep ${MARKER}`], { encoding: "utf8" });
		return out
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((pid) => Number.isInteger(pid) && pid > 1);
	} catch {
		return [];
	}
}

async function poll(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

describe.runIf(isPosix && hasPerl)("bash stall detection end to end", () => {
	let runtimeHost: AgentSessionRuntime | undefined;
	let tempDir: string | undefined;
	let unregisterFaux: (() => void) | undefined;

	afterEach(async () => {
		await runtimeHost?.dispose();
		runtimeHost = undefined;
		// Must not be left to the end of the test body: an assertion failure would
		// leak a globally registered provider into every later test in the worker.
		unregisterFaux?.();
		unregisterFaux = undefined;
		for (const pid of survivors()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("kills a hung command, tells the model it hung, and leaves nothing running", async () => {
		tempDir = join(tmpdir(), `volt-stall-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		unregisterFaux = () => faux.unregister();
		// The command is silent, and its grandchild both ignores SIGTERM and moves
		// itself into a new process group — the shape that survived for hours.
		const hangingCommand = `perl -e '$SIG{TERM}="IGNORE"; setpgrp(0,0); exec("sleep","${MARKER}")' & sleep 120`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: hangingCommand, stallTimeout: 1 })]),
			fauxAssistantMessage("finished"),
		]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const sessionManager = SessionManager.inMemory(tempDir);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager: manager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir as string,
				authStorage,
				cwd,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent,
					model,
					tools: ["bash"],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		const session: AgentSession = runtimeHost.session;
		session.subscribe(() => {});

		// Watch for the victim while the turn runs. Without this, the "nothing
		// survives" assertion below would also pass if the probe never spawned.
		let victimObserved = false;
		const watcher = setInterval(() => {
			if (survivors().length > 0) victimObserved = true;
		}, 50);

		try {
			await session.prompt("run the command");
			await session.waitForIdle();
		} finally {
			clearInterval(watcher);
		}

		expect(victimObserved).toBe(true);

		const toolResults = session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);
		const text = JSON.stringify(toolResults);

		// 1. The model learns the command hung, so it does not retry the same hang.
		expect(text).toMatch(/killed as hung/);

		// 2. Nothing outlives the command.
		expect(await poll(() => survivors().length === 0, 5000)).toBe(true);
	}, 60000);
});
