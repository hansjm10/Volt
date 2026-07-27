import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { type SubagentDefinition, SubagentManager } from "../../../src/core/subagents/index.ts";
import { createSubagentTool } from "../../../src/core/tools/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

interface TestContext {
	manager: SubagentManager;
	parent: SessionManager;
	cleanup(): Promise<void>;
}

function createDefinition(): SubagentDefinition {
	const filePath = join(tmpdir(), "issue-129-researcher.md");
	return {
		name: "researcher",
		description: "Research the task",
		systemPrompt: "Research the task.",
		source: "user",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		filePath,
	};
}

async function createTestContext(options: {
	withConfiguredAuth: boolean;
	parentSessionManager: SessionManager;
}): Promise<TestContext> {
	const children: Harness[] = [];
	const definition = createDefinition();
	const resourceLoader: ResourceLoader = {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
		const child = await createHarness({ withConfiguredAuth: options.withConfiguredAuth });
		children.push(child);
		child.setResponses([fauxAssistantMessage("researched the task"), fauxAssistantMessage("second turn")]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: child.authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		services.settingsManager.applyOverrides({ retry: { enabled: false } });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: child.getModel(),
			noTools: "all",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader,
		requestTimeoutMs: 5_000,
		parentSessionManager: options.parentSessionManager,
	});
	return {
		manager,
		parent: options.parentSessionManager,
		async cleanup() {
			await manager.dispose();
			for (const child of children) child.cleanup();
		},
	};
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function confirmationTokenFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	const token = /"confirm": "([^"]+)"/.exec(textFromResult(result))?.[1];
	if (!token) {
		throw new Error(`Spawn preflight result did not include a confirmation token: ${textFromResult(result)}`);
	}
	return token;
}

function createPersistedParent(): SessionManager {
	const sessionDir = mkdtempSync(join(tmpdir(), "issue-129-sessions-"));
	const parent = SessionManager.create(tmpdir(), sessionDir);
	// A real parent always has conversation content before a spawn (the
	// assistant toolCall); the seeded message also materializes the file.
	parent.appendMessage(fauxAssistantMessage("delegating"));
	return parent;
}

/** A post-"restart" manager whose runtime factory must never fire during hydration. */
function createRestartedManager(parentSessionManager: SessionManager): SubagentManager {
	const definition = createDefinition();
	return new SubagentManager({
		createRuntime: async () => {
			throw new Error("Hydration must not create runtimes");
		},
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader: {
			...createTestResourceLoader(),
			getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
		},
		requestTimeoutMs: 5_000,
		parentSessionManager,
	});
}

describe("issue #129", () => {
	it("records a durable spawn edge when the child's first prompt is accepted", async () => {
		const parent = createPersistedParent();
		const seededLeafId = parent.getLeafId();
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		try {
			const handle = await context.manager.startByName("researcher", {
				spawnRecord: { toolCallId: "call_129", requestKey: "req_129" },
			});
			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);

			const completion = handle.waitForEnd();
			await handle.prompt("inspect the incident");
			await completion;
			await handle.dispose();

			const edges = context.parent.getSubagentSpawnEntries();
			expect(edges).toMatchObject([
				{
					type: "subagent_spawn",
					toolCallId: "call_129",
					requestKey: "req_129",
					subagentId: handle.id,
					agent: "researcher",
					childSessionId: handle.sessionId,
				},
			]);
			expect(edges[0].childSessionFile).toBeDefined();
			expect(edges[0].parentId).toBe(seededLeafId);

			// Host-only sidecar: invisible to the branch and its navigation.
			expect(context.parent.getLeafId()).toBe(seededLeafId);
			expect(context.parent.getEntries().some((entry) => entry.type === "subagent_spawn")).toBe(false);
			expect(context.parent.getBranch().some((entry) => entry.type === "subagent_spawn")).toBe(false);
			expect(context.parent.getEntry(edges[0].id)).toBeUndefined();

			// The edge survives a reload from disk with identical content.
			await context.parent.flush();
			const parentFile = context.parent.getSessionFile();
			expect(parentFile).toBeDefined();
			const reloaded = SessionManager.open(parentFile!);
			expect(reloaded.getSubagentSpawnEntries()).toEqual(edges);
			expect(reloaded.getLeafId()).toBe(seededLeafId);
			expect(reloaded.getEntries().some((entry) => entry.type === "subagent_spawn")).toBe(false);
		} finally {
			await context.cleanup();
		}
	});

	it("records edges with real tool-call attribution through the subagent tool", async () => {
		const parent = createPersistedParent();
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		const observedTypes: string[] = [];
		const unsubscribe = parent.subscribeEntries((entry) => {
			observedTypes.push(entry.type);
		});
		try {
			const tool = createSubagentTool(tmpdir(), { manager: context.manager });
			const parallelParams = {
				tasks: [
					{ agent: "researcher", task: "task one" },
					{ agent: "researcher", task: "task two" },
				],
			};
			// Real managers require the preflight/confirm round-trip; the
			// preflight reserves without spawning, so it must record nothing.
			const preflight = await tool.execute("call_preflight", parallelParams);
			expect(context.parent.getSubagentSpawnEntries()).toHaveLength(0);
			await tool.execute("call_parallel", {
				...parallelParams,
				confirm: confirmationTokenFromResult(preflight),
			});

			const parallelEdges = context.parent.getSubagentSpawnEntries();
			expect(parallelEdges).toHaveLength(2);
			for (const edge of parallelEdges) {
				expect(edge.toolCallId).toBe("call_parallel");
				expect(edge.agent).toBe("researcher");
				expect(edge.childSessionFile).toBeDefined();
			}
			expect(parallelEdges[0].requestKey).not.toBe("");
			expect(parallelEdges[1].requestKey).toBe(parallelEdges[0].requestKey);
			expect(parallelEdges[1].subagentId).not.toBe(parallelEdges[0].subagentId);
			expect(parallelEdges[1].childSessionId).not.toBe(parallelEdges[0].childSessionId);

			const singleParams = { agent: "researcher", task: "task one" };
			const singlePreflight = await tool.execute("call_single_preflight", singleParams);
			await tool.execute("call_single", {
				...singleParams,
				confirm: confirmationTokenFromResult(singlePreflight),
			});
			const edges = context.parent.getSubagentSpawnEntries();
			expect(edges).toHaveLength(3);
			expect(edges[2].toolCallId).toBe("call_single");
			// The key derives from the whole request: single and parallel mode
			// differ even with an identical first task.
			expect(edges[2].requestKey).not.toBe(parallelEdges[0].requestKey);

			// Privacy: entry listeners never observe a spawn edge.
			expect(observedTypes).not.toContain("subagent_spawn");
		} finally {
			unsubscribe();
			await context.cleanup();
		}
	});

	it("records exactly one edge per child across repeat prompts on the same handle", async () => {
		const parent = createPersistedParent();
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		try {
			const handle = await context.manager.startByName("researcher", {
				spawnRecord: { toolCallId: "call_129", requestKey: "req_129" },
			});
			const completion = handle.waitForEnd();
			await handle.prompt("inspect the incident");
			await completion;
			await handle.prompt("look again").catch(() => undefined);
			await handle.dispose();

			expect(context.parent.getSubagentSpawnEntries()).toHaveLength(1);
		} finally {
			await context.cleanup();
		}
	});

	it("records no edge for a ghost spawn whose first prompt is rejected", async () => {
		const parent = createPersistedParent();
		const context = await createTestContext({ withConfiguredAuth: false, parentSessionManager: parent });
		try {
			const handle = await context.manager.startByName("researcher", {
				spawnRecord: { toolCallId: "call_129", requestKey: "req_129" },
			});
			await expect(handle.prompt("inspect the incident")).rejects.toThrow(/API key/i);
			await handle.dispose();

			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
		} finally {
			await context.cleanup();
		}
	});

	it("records no edge for programmatic starts without spawn attribution", async () => {
		const parent = createPersistedParent();
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		try {
			const handle = await context.manager.startByName("researcher");
			const completion = handle.waitForEnd();
			await handle.prompt("inspect the incident");
			await completion;
			await handle.dispose();

			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
		} finally {
			await context.cleanup();
		}
	});

	it("hydrates an unclaimed completed child into a reopened session's registry", async () => {
		const parent = createPersistedParent();
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		let handleId: string;
		try {
			// Manager-level spawn: no toolResult ever settles in the parent, so
			// this edge is dangling by construction — the incident shape.
			const handle = await context.manager.startByName("researcher", {
				spawnRecord: { toolCallId: "call_129", requestKey: "req_129" },
			});
			handleId = handle.id;
			const completion = handle.waitForEnd();
			await handle.prompt("inspect the incident");
			await completion;
			await handle.dispose();
			await parent.flush();
		} finally {
			await context.cleanup();
		}

		const parentFile = parent.getSessionFile();
		expect(parentFile).toBeDefined();
		const reopened = SessionManager.open(parentFile!);
		const restarted = createRestartedManager(reopened);
		try {
			await restarted.ensureRegistryHydrated();
			const records = restarted.listDelegations();
			expect(records).toMatchObject([
				{
					id: handleId,
					agent: { name: "researcher" },
					path: ["researcher"],
					task: "inspect the incident",
					status: "completed",
					hydrated: true,
				},
			]);

			const followed = await restarted.followDelegation(handleId);
			expect(followed.status).toBe("completed");
			expect(followed.output).toBe("researched the task");
		} finally {
			await restarted.dispose();
		}
	});

	it("hydrates interrupted and unrecoverable edges with derived statuses", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();

		// Interrupted mid-second-turn: the transcript ends on an unanswered user
		// message. (A lone user message is not flush content, so a child
		// interrupted before any assistant output persists as header-only and
		// hydrates the same way, just without a task.)
		const interruptedChild = SessionManager.create(tmpdir(), sessionDir);
		interruptedChild.appendMessage({ role: "user", content: "dig into logs", timestamp: Date.now() });
		interruptedChild.appendMessage(fauxAssistantMessage("starting the dig"));
		interruptedChild.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		await interruptedChild.flush();
		parent.appendSubagentSpawn({
			toolCallId: "call_a",
			subagentId: "sa_interrupted",
			agent: "researcher",
			childSessionId: interruptedChild.getSessionId(),
			childSessionFile: interruptedChild.getSessionFile()!,
			requestKey: "rk-a",
		});
		parent.appendSubagentSpawn({
			toolCallId: "call_b",
			subagentId: "sa_lost",
			agent: "researcher",
			childSessionId: "missing-child",
			childSessionFile: join(sessionDir, "does-not-exist.jsonl"),
			requestKey: "rk-b",
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await restarted.ensureRegistryHydrated();
			const byId = new Map(restarted.listDelegations().map((record) => [record.id, record]));
			expect(byId.get("sa_interrupted")).toMatchObject({
				status: "aborted",
				hydrated: true,
				task: "dig into logs",
				error: expect.stringContaining("Interrupted before completion"),
			});
			expect(byId.get("sa_lost")).toMatchObject({
				status: "failed",
				hydrated: true,
				error: expect.stringContaining("unreadable"),
			});
		} finally {
			await restarted.dispose();
		}
	});

	it("skips settled edges but hydrates abort-marker results", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();
		const makeChild = (task: string): SessionManager => {
			const child = SessionManager.create(tmpdir(), sessionDir);
			child.appendMessage({ role: "user", content: task, timestamp: Date.now() });
			child.appendMessage(fauxAssistantMessage("finished cleanly"));
			return child;
		};
		const settledChild = makeChild("settled work");
		const abortedCallChild = makeChild("recoverable work");
		await settledChild.flush();
		await abortedCallChild.flush();
		parent.appendSubagentSpawn({
			toolCallId: "call_settled",
			subagentId: "sa_settled",
			agent: "researcher",
			childSessionId: settledChild.getSessionId(),
			childSessionFile: settledChild.getSessionFile()!,
			requestKey: "rk-1",
		});
		parent.appendSubagentSpawn({
			toolCallId: "call_aborted",
			subagentId: "sa_recoverable",
			agent: "researcher",
			childSessionId: abortedCallChild.getSessionId(),
			childSessionFile: abortedCallChild.getSessionFile()!,
			requestKey: "rk-2",
		});
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "call_settled",
			toolName: "subagent",
			content: [{ type: "text", text: "real settled result" }],
			isError: false,
			timestamp: Date.now(),
		});
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "call_aborted",
			toolName: "subagent",
			content: [{ type: "text", text: "Operation aborted: the session closed before this tool call completed." }],
			isError: true,
			timestamp: Date.now(),
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await restarted.ensureRegistryHydrated();
			const records = restarted.listDelegations();
			expect(records).toMatchObject([
				{ id: "sa_recoverable", status: "completed", hydrated: true, task: "recoverable work" },
			]);
		} finally {
			await restarted.dispose();
		}
	});

	it("marks edges without a matching toolCall in the transcript as stranded", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();
		const makeChild = (task: string, report: string): SessionManager => {
			const child = SessionManager.create(tmpdir(), sessionDir);
			child.appendMessage({ role: "user", content: task, timestamp: Date.now() });
			child.appendMessage(fauxAssistantMessage(report));
			return child;
		};
		const linkedChild = makeChild("linked work", "linked report");
		const strandedChild = makeChild("stranded work", "stranded report");
		await linkedChild.flush();
		await strandedChild.flush();

		parent.appendMessage(
			fauxAssistantMessage([fauxToolCall("subagent", {}, { id: "call_linked" })], { stopReason: "toolUse" }),
		);
		parent.appendSubagentSpawn({
			toolCallId: "call_linked",
			subagentId: "sa_linked",
			agent: "researcher",
			childSessionId: linkedChild.getSessionId(),
			childSessionFile: linkedChild.getSessionFile()!,
			requestKey: "rk-1",
		});
		parent.appendSubagentSpawn({
			toolCallId: "call_gone",
			subagentId: "sa_stranded",
			agent: "researcher",
			childSessionId: strandedChild.getSessionId(),
			childSessionFile: strandedChild.getSessionFile()!,
			requestKey: "rk-2",
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await restarted.ensureRegistryHydrated();
			const byId = new Map(restarted.listDelegations().map((record) => [record.id, record]));
			expect(byId.get("sa_linked")).toMatchObject({ status: "completed" });
			expect(byId.get("sa_linked")?.stranded).toBeUndefined();
			expect(byId.get("sa_stranded")).toMatchObject({ status: "completed", stranded: true });
		} finally {
			await restarted.dispose();
		}
	});

	it("recovers an unsettled grandchild beneath a settled child edge", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();

		const grandchild = SessionManager.create(tmpdir(), sessionDir);
		grandchild.appendMessage({ role: "user", content: "orphaned leaf work", timestamp: Date.now() });
		grandchild.appendMessage(fauxAssistantMessage("orphaned leaf report"));
		await grandchild.flush();

		// The child settled in the parent (its failure was captured as a task
		// error), but its own toolCall to the grandchild never settled.
		const child = SessionManager.create(tmpdir(), sessionDir);
		child.appendMessage({ role: "user", content: "branch task", timestamp: Date.now() });
		child.appendMessage(
			fauxAssistantMessage([fauxToolCall("subagent", {}, { id: "call_leaf" })], { stopReason: "toolUse" }),
		);
		child.appendSubagentSpawn({
			toolCallId: "call_leaf",
			subagentId: "sa_orphaned_leaf",
			agent: "general",
			childSessionId: grandchild.getSessionId(),
			childSessionFile: grandchild.getSessionFile()!,
			requestKey: "rk-leaf",
		});
		await child.flush();

		parent.appendSubagentSpawn({
			toolCallId: "call_settled_branch",
			subagentId: "sa_settled_branch",
			agent: "researcher",
			childSessionId: child.getSessionId(),
			childSessionFile: child.getSessionFile()!,
			requestKey: "rk-branch",
		});
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "call_settled_branch",
			toolName: "subagent",
			content: [{ type: "text", text: "branch failed: budget exhausted" }],
			isError: true,
			timestamp: Date.now(),
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await restarted.ensureRegistryHydrated();
			const byId = new Map(restarted.listDelegations().map((record) => [record.id, record]));
			expect(byId.has("sa_settled_branch")).toBe(false);
			expect(byId.get("sa_orphaned_leaf")).toMatchObject({
				status: "completed",
				parentId: "sa_settled_branch",
				path: ["researcher", "general"],
				task: "orphaned leaf work",
			});
		} finally {
			await restarted.dispose();
		}
	});

	it("hydrates grandchildren recursively from child transcript edges", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();

		const grandchild = SessionManager.create(tmpdir(), sessionDir);
		grandchild.appendMessage({ role: "user", content: "leaf task", timestamp: Date.now() });
		grandchild.appendMessage(fauxAssistantMessage("leaf report"));
		await grandchild.flush();

		const child = SessionManager.create(tmpdir(), sessionDir);
		child.appendMessage({ role: "user", content: "branch task", timestamp: Date.now() });
		child.appendMessage(fauxAssistantMessage("branch report"));
		child.appendSubagentSpawn({
			toolCallId: "call_leaf",
			subagentId: "sa_leaf",
			agent: "general",
			childSessionId: grandchild.getSessionId(),
			childSessionFile: grandchild.getSessionFile()!,
			requestKey: "rk-leaf",
		});
		await child.flush();

		parent.appendSubagentSpawn({
			toolCallId: "call_branch",
			subagentId: "sa_branch",
			agent: "researcher",
			childSessionId: child.getSessionId(),
			childSessionFile: child.getSessionFile()!,
			requestKey: "rk-branch",
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await restarted.ensureRegistryHydrated();
			const byId = new Map(restarted.listDelegations().map((record) => [record.id, record]));
			expect(byId.get("sa_branch")).toMatchObject({
				status: "completed",
				path: ["researcher"],
			});
			expect(byId.get("sa_leaf")).toMatchObject({
				status: "completed",
				parentId: "sa_branch",
				path: ["researcher", "general"],
				task: "leaf task",
			});
		} finally {
			await restarted.dispose();
		}
	});

	it("resume reloads an interrupted run through the subagent tool without confirmation", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();
		const interrupted = SessionManager.create(tmpdir(), sessionDir);
		interrupted.appendMessage({ role: "user", content: "finish the audit", timestamp: Date.now() });
		interrupted.appendMessage(fauxAssistantMessage("starting the audit"));
		interrupted.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		await interrupted.flush();
		parent.appendSubagentSpawn({
			toolCallId: "call_resume",
			subagentId: "sa_resume",
			agent: "researcher",
			childSessionId: interrupted.getSessionId(),
			childSessionFile: interrupted.getSessionFile()!,
			requestKey: "rk-resume",
		});
		await parent.flush();

		const reopened = SessionManager.open(parent.getSessionFile()!);
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: reopened });
		try {
			const tool = createSubagentTool(tmpdir(), { manager: context.manager });
			// Resume takes no preflight/confirm round-trip: one call starts it.
			const result = await tool.execute("call_do_resume", { resume: "sa_resume" });
			const text = textFromResult(result);
			expect(text).toContain("Resumed subagent run sa_resume");
			expect(text).toContain("researched the task");

			const record = context.manager.listDelegations().find((candidate) => candidate.id === "sa_resume");
			expect(record).toMatchObject({ status: "completed" });
			expect(record?.hydrated).toBeUndefined();

			// The resumed turn appended to the same child transcript.
			await vi.waitFor(() => {
				const childEntries = SessionManager.open(interrupted.getSessionFile()!).getEntries();
				const hasResumedReport = childEntries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						JSON.stringify(entry.message.content).includes("researched the task"),
				);
				expect(hasResumedReport).toBe(true);
			});
		} finally {
			await context.cleanup();
		}
	});

	it("resume rejects completed recoveries and unknown ids while follow still works", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();
		const completedChild = SessionManager.create(tmpdir(), sessionDir);
		completedChild.appendMessage({ role: "user", content: "settled work", timestamp: Date.now() });
		completedChild.appendMessage(fauxAssistantMessage("finished report"));
		await completedChild.flush();
		parent.appendSubagentSpawn({
			toolCallId: "call_completed",
			subagentId: "sa_completed",
			agent: "researcher",
			childSessionId: completedChild.getSessionId(),
			childSessionFile: completedChild.getSessionFile()!,
			requestKey: "rk-c",
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await expect(restarted.resumeDelegation("sa_completed")).rejects.toThrow(/not a resumable/);
			await expect(restarted.resumeDelegation("sa_missing")).rejects.toThrow(/not a resumable/);
			const followed = await restarted.followDelegation("sa_completed");
			expect(followed.output).toBe("finished report");
		} finally {
			await restarted.dispose();
		}
	});

	it("resume start failure restores the interrupted record", async () => {
		const parent = createPersistedParent();
		const sessionDir = parent.getSessionDir();
		const interrupted = SessionManager.create(tmpdir(), sessionDir);
		interrupted.appendMessage({ role: "user", content: "ghost work", timestamp: Date.now() });
		interrupted.appendMessage(fauxAssistantMessage("partial"));
		interrupted.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		await interrupted.flush();
		// The agent definition no longer exists in the restarted process.
		parent.appendSubagentSpawn({
			toolCallId: "call_ghost",
			subagentId: "sa_ghost",
			agent: "ghost-agent",
			childSessionId: interrupted.getSessionId(),
			childSessionFile: interrupted.getSessionFile()!,
			requestKey: "rk-g",
		});
		await parent.flush();

		const restarted = createRestartedManager(parent);
		try {
			await expect(restarted.resumeDelegation("sa_ghost")).rejects.toThrow();
			const record = restarted.listDelegations().find((candidate) => candidate.id === "sa_ghost");
			expect(record).toMatchObject({ status: "aborted", hydrated: true });
		} finally {
			await restarted.dispose();
		}
	});

	it("records no edge when the parent session is in-memory", async () => {
		const parent = SessionManager.inMemory(tmpdir());
		const context = await createTestContext({ withConfiguredAuth: true, parentSessionManager: parent });
		try {
			const handle = await context.manager.startByName("researcher", {
				spawnRecord: { toolCallId: "call_129", requestKey: "req_129" },
			});
			const completion = handle.waitForEnd();
			await handle.prompt("inspect the incident");
			await completion;
			await handle.dispose();

			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
		} finally {
			await context.cleanup();
		}
	});
});
