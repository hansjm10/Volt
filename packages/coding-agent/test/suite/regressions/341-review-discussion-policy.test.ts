import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { DefaultMcpClientFactory } from "../../../src/core/mcp/client-factory.ts";
import type { McpClientConnection } from "../../../src/core/mcp/types.ts";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	RESEARCH_OPERATION_GRANT_PROFILE,
	REVIEW_DISCUSSION_OPERATION_GRANT_PROFILE,
} from "../../../src/core/operation-authorization.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	type SessionStoreCreateSessionInput,
	SQLiteSessionStoreClient,
} from "../../../src/core/session-store/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];
const harnesses: Harness[] = [];
const sdkSessions: AgentSession[] = [];

function childInput(id: string, cwd: string): SessionStoreCreateSessionInput {
	return {
		id,
		cwd,
		sessionGeneration: randomUUID(),
		formatVersion: 5,
		createdAt: new Date().toISOString(),
		parentSessionDirectory: null,
		parentStoreId: null,
		parentSessionId: null,
		parentSessionGeneration: null,
		origin: null,
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-341-policy-"));
	roots.push(root);
	const directory = join(root, "sessions");
	const source = await SessionManager.create(root, directory);
	const sourceRef = source.getSessionRef()!;
	await source.closePersistence();
	const store = await SQLiteSessionStoreClient.open(directory);
	try {
		const sourceIdentity = {
			sessionId: sourceRef.sessionId,
			sessionGeneration: sourceRef.sessionGeneration,
			cwd: root,
		};
		const createdAt = new Date().toISOString();
		await store.registerReviewAnchor({ runId: "run", source: sourceIdentity, createdAt });
		const discussion = await store.createOrGetReviewDiscussion({
			source: sourceIdentity,
			runId: "run",
			findingId: "finding",
			discussionId: "discussion",
			child: childInput("child", root),
			contextSnapshot: { finding: "Canonical finding" },
			createdAt,
			requestId: "create",
			kickoffClientMessageId: "kickoff",
		});
		const childRef: SessionReference = { ...sourceRef, ...discussion.current.child };
		return { root, directory, sourceRef, childRef, discussion };
	} finally {
		await store.close();
	}
}

async function open(ref: SessionReference): Promise<SessionManager> {
	const manager = await SessionManager.open(ref);
	managers.push(manager);
	return manager;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
	const result = await createHarness({
		settings: { lsp: { enabled: false }, compaction: { enabled: false } },
		...options,
	});
	harnesses.push(result);
	result.session.setSessionName("Review discussion policy test");
	return result;
}

afterEach(async () => {
	for (const session of sdkSessions.splice(0)) {
		session.dispose();
		await session.waitForClosed();
	}
	for (const item of harnesses.splice(0)) await item.cleanupAsync();
	for (const manager of managers.splice(0)) await manager.closePersistence();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Regression #341: persisted review discussion policy", () => {
	it("uses exactly the research capabilities minus plan authoring", () => {
		expect([...REVIEW_DISCUSSION_OPERATION_GRANT_PROFILE.capabilities]).toEqual(
			[...RESEARCH_OPERATION_GRANT_PROFILE.capabilities].filter((capability) => capability !== "session.plan"),
		);
		for (const name of [
			"write",
			"edit",
			"bash",
			"subagent",
			"subagent_registry",
			"image_gen",
			"custom",
			"update_plan",
			"submit_plan",
			"update_plan_progress",
			"request_replan",
		]) {
			expect(
				authorizeToolOperation(getTrustedToolOperationResolver(name), {}, REVIEW_DISCUSSION_OPERATION_GRANT_PROFILE)
					.allowed,
			).toBe(false);
		}
	});

	it("keeps historical children restricted after source-controlled reset and source deletion", async () => {
		const { childRef, sourceRef, root, directory, discussion } = await fixture();
		const store = await SQLiteSessionStoreClient.open(directory);
		try {
			const reset = await store.resetReviewDiscussion({
				source: discussion.source,
				discussionId: discussion.discussionId,
				expectedChild: discussion.current.child,
				child: childInput("next-child", root),
				createdAt: new Date().toISOString(),
				requestId: "reset",
				kickoffClientMessageId: "next-kickoff",
			});
			await store.deleteSession({
				sessionId: sourceRef.sessionId,
				sessionGeneration: sourceRef.sessionGeneration,
				expectedRevision: 0,
			});
			for (const ref of [childRef, { ...childRef, ...reset.child.child }]) {
				const item = await harness({ sessionManager: await open(ref) });
				expect(item.session.isReviewDiscussion).toBe(true);
				expect(item.sessionManager.getReviewDiscussion()?.discussion.sourceAvailable).toBe(false);
				expect(item.sessionManager.getReviewDiscussion()?.discussion.current.child).toEqual(reset.child.child);
				expect(item.sessionManager.getReviewDiscussion()?.child.child).toEqual({
					sessionId: ref.sessionId,
					sessionGeneration: ref.sessionGeneration,
				});
				await item.session.setAgentMode("plan");
				await item.session.setAgentMode("build");
				expect(item.session.getActiveToolNames()).not.toContain("bash");
			}
		} finally {
			await store.close();
		}
	});

	it("does not rebind a deleted child's id to a new generation and fails closed on lookup errors", async () => {
		const { childRef, root, directory } = await fixture();
		const snapshot = join(root, "child.jsonl");
		await SessionManager.exportJsonlSnapshot(childRef, snapshot);
		await SessionManager.delete(childRef);
		const imported = await SessionManager.importFromJsonl(snapshot, root, directory);
		managers.push(imported);
		expect(imported.getSessionId()).toBe(childRef.sessionId);
		expect(imported.getSessionRef()?.sessionGeneration).not.toBe(childRef.sessionGeneration);
		expect(imported.getReviewDiscussion()).toBeNull();
		const newRef = imported.getSessionRef()!;
		await imported.closePersistence();
		vi.spyOn(SQLiteSessionStoreClient.prototype, "findReviewDiscussionByChild").mockRejectedValueOnce(
			new Error("lookup unavailable"),
		);
		await expect(SessionManager.open(newRef)).rejects.toThrow("lookup unavailable");
		const reopened = await open(newRef);
		expect(reopened.getReviewDiscussion()).toBeNull();
	});
	it("loads the exact binding synchronously before runtime construction, including continuation and reopen", async () => {
		const { childRef, root, directory, discussion } = await fixture();
		const first = await open(childRef);
		expect(first.getReviewDiscussion()).toEqual({ discussion, child: discussion.current });
		expect(Object.isFrozen(first.getReviewDiscussion()?.discussion.current.child)).toBe(true);
		first.appendMessage({ role: "user", content: "Discuss the finding", timestamp: Date.now() });
		await first.closePersistence();
		const continued = await SessionManager.continueRecent(root, directory);
		managers.push(continued);
		expect(continued.getSessionRef()).toEqual(childRef);
		expect(continued.getReviewDiscussion()?.child.child).toEqual(discussion.current.child);
		await continued.closePersistence();
		const item = await harness({
			sessionManager: await open(childRef),
			initialActiveToolNames: ["read", "write", "bash", "lsp"],
		});
		expect(item.session.isReviewDiscussion).toBe(true);
		expect(item.session.agentMode).toBe("build");
		expect(item.session.getActiveToolNames()).toEqual(["read", "lsp"]);
		expect(item.session.getAllTools().map((tool) => tool.name)).toEqual(["read", "lsp"]);
		expect(item.session.getToolDefinition("write")).toBeUndefined();
	});

	it("keeps source, general, in-memory and metadata-only imported/forked sessions unrestricted", async () => {
		const { root, directory, sourceRef, discussion } = await fixture();
		const source = await open(sourceRef);
		const metadata = {
			discussionId: discussion.discussionId,
			runId: discussion.runId,
			findingId: discussion.findingId,
			child: { ...discussion.current.child },
			isReviewDiscussion: true,
			readOnly: true,
		};
		source.appendCustomEntry("review_discussion", metadata);
		source.appendCustomMessageEntry("review-discussion", "Copied finding", false, metadata);
		await source.closePersistence();
		const fork = await SessionManager.forkFrom(sourceRef, root, directory);
		managers.push(fork);
		expect(fork.getReviewDiscussion()).toBeNull();
		const oldRef = fork.getSessionRef();
		await fork.flush();
		fork.newSession();
		await fork.flush();
		expect(fork.getSessionRef()).not.toEqual(oldRef);
		expect(fork.getReviewDiscussion()).toBeNull();
		const snapshot = join(root, "import.jsonl");
		await SessionManager.exportJsonlSnapshot(sourceRef, snapshot);
		const imported = await SessionManager.importFromJsonl(snapshot, root, directory, { id: "imported" });
		managers.push(imported);
		const normal = await harness({ sessionManager: imported, initialActiveToolNames: ["read", "write", "bash"] });
		expect(normal.session.isReviewDiscussion).toBe(false);
		expect(normal.session.getActiveToolNames()).toEqual(["read", "write", "bash"]);
		const path = join(root, "normal.txt");
		await normal.session.state.tools
			.find((tool) => tool.name === "write")!
			.execute("normal", { path, content: "written" });
		expect(readFileSync(path, "utf8")).toBe("written");
		const reopenedSource = await harness({ sessionManager: await open(sourceRef) });
		expect(reopenedSource.session.isReviewDiscussion).toBe(false);
		expect(reopenedSource.session.getActiveToolNames()).toContain("bash");
		expect(SessionManager.inMemory().getReviewDiscussion()).toBeNull();
	});

	it("cannot widen the ceiling by mode switches, tool selection, reload, or custom tools named like reads", async () => {
		const { childRef } = await fixture();
		const customExecute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "not a trusted read" }],
			details: {},
		}));
		const item = await harness({
			sessionManager: await open(childRef),
			initialActiveToolNames: ["read", "ls", "write", "bash", "lsp"],
			allowedToolNames: ["read", "ls", "write", "bash", "lsp", "custom"],
			excludedToolNames: ["ls"],
			extensionFactories: [
				(volt) => {
					for (const name of ["read", "custom"])
						volt.registerTool({
							name,
							label: name,
							description: name,
							parameters: Type.Object({}),
							execute: customExecute,
						});
				},
			],
		});
		for (const mode of ["plan", "build", "plan", "build"] as const) {
			await item.session.setAgentMode(mode);
			item.session.setActiveToolsByName([
				"read",
				"ls",
				"write",
				"bash",
				"lsp",
				"custom",
				"update_plan",
				"submit_plan",
				"subagent",
				"image_gen",
			]);
			expect(item.session.getActiveToolNames()).toEqual(["lsp"]);
			expect(item.session.getAllTools().map((tool) => tool.name)).toEqual(["lsp"]);
		}
		await item.session.reload();
		expect(item.session.getActiveToolNames()).toEqual(["lsp"]);
		expect(item.session.isReviewDiscussion).toBe(true);
		expect(customExecute).not.toHaveBeenCalled();
		item.session.setActiveToolsByName([]);
		await item.session.toggleAgentMode();
		expect(item.session.getActiveToolNames()).toEqual([]);
	});

	it("rejects direct shell, plan authoring/execution, export, trace and identity escape APIs", async () => {
		const { childRef, root, directory } = await fixture();
		const item = await harness({ sessionManager: await open(childRef) });
		const execute = vi.fn();
		await expect(
			item.session.executeBash("touch forbidden", undefined, { operations: { exec: execute } }),
		).rejects.toThrow("read-only");
		expect(execute).not.toHaveBeenCalled();
		expect(() =>
			item.session.recordBashResult("echo bad", { output: "bad", exitCode: 0, cancelled: false, truncated: false }),
		).toThrow("read-only");
		await item.session.setAgentMode("plan");
		expect(() => item.session.updatePlan({ steps: [{ text: "Mutate" }] })).toThrow("read-only");
		expect(() => item.session.submitPlan({ planId: "p", expectedRevision: 1, title: "t", summary: "s" })).toThrow(
			"read-only",
		);
		expect(() => item.session.updatePlanProgress({ planId: "p", expectedRevision: 1, updates: [] })).toThrow(
			"read-only",
		);
		expect(() => item.session.requestReplan({ planId: "p", expectedRevision: 1, reason: "mutate" })).toThrow(
			"read-only",
		);
		expect(() => item.session.changePlan("p", 1)).toThrow("read-only");
		expect(() => item.session.discardPlan("p", 1)).toThrow("read-only");
		const execution = {
			id: "e",
			approvedRevision: 1,
			strategy: "retain_context" as const,
			sourceSessionId: "s",
			targetSessionId: "t",
		};
		await expect(item.session.activatePlan("p", 1, execution)).rejects.toThrow("read-only");
		await expect(item.session.markPlanHandedOff("p", 1, execution)).rejects.toThrow("read-only");
		expect(() => item.session.exportToJsonl(join(root, "forbidden.jsonl"))).toThrow("read-only");
		await expect(item.session.exportToHtml(join(root, "forbidden.html"))).rejects.toThrow("read-only");
		expect(() => item.session.setLspTraceFile(join(root, "trace"))).toThrow("read-only");
		expect(() => item.session.restartLspServers()).toThrow("read-only");
		await item.sessionManager.flush();
		expect(() => item.sessionManager.newSession()).toThrow("source session");
		await expect(item.sessionManager.createBranchedSession(item.sessionManager.getLeafId()!)).rejects.toThrow(
			"source session",
		);
		await expect(SessionManager.forkFrom(childRef, root, directory)).rejects.toThrow("read-only");
		expect(item.session.sessionRef).toEqual(childRef);
	});

	it("authorizes rewritten extension arguments, final execution arguments, trusted reads and inactive tools", async () => {
		const { childRef, root } = await fixture();
		const item = await harness({
			sessionManager: await open(childRef),
			initialActiveToolNames: ["read", "lsp", "inspect", "write"],
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", (event) => {
						if (event.toolName === "lsp") event.input.action = "fix";
					});
				},
			],
		});
		const decision = await item.control.evaluateToolCall({
			type: "tool_call",
			toolCallId: "rewrite",
			toolName: "lsp",
			input: { action: "diagnostics" },
		});
		expect(decision).toMatchObject({ block: true, reason: expect.stringContaining("workspace.write") });
		const lsp = item.session.state.tools.find((tool) => tool.name === "lsp")!;
		await expect(
			lsp.execute("direct", { action: "rename", path: "file.ts", symbol: "old", newName: "new" }),
		).rejects.toThrow("workspace.write");
		await expect(lsp.execute("unknown", { action: "future" })).rejects.toThrow("unknown");
		const inspect = item.session.state.tools.find((tool) => tool.name === "inspect")!;
		await expect(inspect.execute("unsafe", { operation: "git.diff", args: ["--output=forbidden"] })).rejects.toThrow(
			"read-only",
		);
		const path = join(root, "evidence.txt");
		writeFileSync(path, "trusted read evidence");
		const read = item.session.state.tools.find((tool) => tool.name === "read")!;
		expect(await read.execute("read", { path })).toMatchObject({
			content: [{ type: "text", text: "trusted read evidence" }],
		});
		item.session.setActiveToolsByName([]);
		await expect(read.execute("stale", { path })).rejects.toThrow("not active");
		item.session.setActiveToolsByName(["read", "lsp"]);
		const definition = item.session.getToolDefinition("lsp")!;
		await expect(
			definition.execute(
				"definition",
				{ action: "fix" },
				undefined,
				undefined,
				item.session.extensionRunner.createContext(),
			),
		).rejects.toThrow("workspace.write");
		await item.session.reload();
		await expect(read.execute("old-registry", { path })).rejects.toThrow("stale");
		await expect(
			definition.execute(
				"old-definition",
				{ action: "diagnostics" },
				undefined,
				undefined,
				item.session.extensionRunner.createContext(),
			),
		).rejects.toThrow("stale");
	});

	it("blocks model mutation attempts and extension argument rewrites without modifying the workspace", async () => {
		const { childRef, root } = await fixture();
		const item = await harness({
			sessionManager: await open(childRef),
			initialActiveToolNames: ["lsp", "write"],
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", (event) => {
						if (event.toolName === "lsp") event.input.action = "fix";
					});
				},
			],
		});
		item.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("lsp", { action: "diagnostics", path: join(root, "file.ts") }),
					fauxToolCall("write", { path: join(root, "forbidden"), content: "bad" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Read-only discussion"),
		]);
		await item.session.prompt("Inspect the finding");
		const results = item.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every((result) => result.isError)).toBe(true);
		expect(JSON.stringify(results)).toContain("workspace.write");
		expect(existsSync(join(root, "forbidden"))).toBe(false);
	});

	it("checks final execution authority after later hooks revoke an otherwise authorized tool", async () => {
		const { childRef, root } = await fixture();
		const path = join(root, "evidence.txt");
		writeFileSync(path, "must not be read after revocation");
		const item = await harness({ sessionManager: await open(childRef), initialActiveToolNames: ["read"] });
		item.session.registerTurnPolicy({
			beforeToolCall: () => {
				item.session.setActiveToolsByName([]);
				return undefined;
			},
		});
		item.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Read was revoked"),
		]);
		await item.session.prompt("Read evidence");
		const result = item.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("not active");
		expect(JSON.stringify(result)).not.toContain("must not be read after revocation");
	});

	it("terminalizes interrupted inputs without replay and accepts only a new explicit retry", async () => {
		const { childRef } = await fixture();
		const manager = await open(childRef);
		for (const id of ["accepted", "started", "queued"]) {
			manager.reserveClientInput(id, id === "queued" ? "follow_up" : "prompt", { message: `old ${id}`, images: [] });
		}
		manager.transitionClientInput("started", "started");
		manager.markClientInputQueued("queued", { delivery: "follow_up", message: "old queued", images: [] });
		await manager.closePersistence();
		const item = await harness({ sessionManager: await open(childRef) });
		const respond = vi.fn(() => fauxAssistantMessage("Explicit retry answer"));
		item.setResponses([respond]);
		await item.session.resumeRecoveredClientInputs();
		expect(respond).not.toHaveBeenCalled();
		expect(item.session.pendingMessageCount).toBe(0);
		for (const id of ["accepted", "started", "queued"]) {
			expect(item.sessionManager.getClientInput(id)).toMatchObject({
				state: "failed",
				error: expect.stringContaining("interrupted"),
			});
		}
		expect(item.sessionManager.getClientInputRecoveryPlan().kind).toBe("idle");
		await item.session.prompt("Retry the discussion explicitly", { source: "rpc", clientMessageId: "fresh-retry" });
		expect(respond).toHaveBeenCalledOnce();
		expect(item.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(item.sessionManager.getClientInput("fresh-retry")?.state).toBe("completed");
		await item.session.resumeRecoveredClientInputs();
		expect(respond).toHaveBeenCalledOnce();
	});

	it("rejects arbitrary extension commands before their handlers run", async () => {
		const { childRef } = await fixture();
		const handler = vi.fn();
		const item = await harness({
			sessionManager: await open(childRef),
			extensionFactories: [
				(volt) => {
					volt.registerCommand("mutate", { description: "untrusted command", handler });
				},
			],
		});
		await expect(item.session.prompt("/mutate")).rejects.toThrow("read-only");
		expect(handler).not.toHaveBeenCalled();
	});

	it("never offers a missing-server installation from a discussion LSP read", async () => {
		const { childRef, sourceRef, root } = await fixture();
		const provider = await harness({ settings: { lsp: { enabled: true }, compaction: { enabled: false } } });
		const requestAction = vi.fn(async () => ({ decision: "denied" as const }));
		const path = join(root, "evidence.py");
		writeFileSync(path, "value = 1\n");
		const sessions: AgentSession[] = [];
		for (const ref of [childRef, sourceRef]) {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				sessionManager: await open(ref),
				model: provider.getModel(),
				authStorage: provider.authStorage,
				modelRegistry: provider.session.modelRegistry,
				settingsManager: provider.settingsManager,
				resourceLoader: provider.session.resourceLoader,
				hostInteraction: { requestAction },
				disableMcp: true,
				tools: ["lsp"],
			});
			sdkSessions.push(session);
			sessions.push(session);
		}
		vi.stubEnv("PATH", root);
		try {
			await sessions[0]!.state.tools
				.find((tool) => tool.name === "lsp")!
				.execute("child-read", {
					action: "diagnostics",
					path,
				});
			expect(requestAction).not.toHaveBeenCalled();
			await sessions[1]!.state.tools
				.find((tool) => tool.name === "lsp")!
				.execute("source-read", {
					action: "diagnostics",
					path,
				});
			expect(requestAction).toHaveBeenCalledWith(
				expect.objectContaining({ action: "lsp.install_server" }),
				expect.anything(),
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("applies restricted MCP startup and fresh trusted-read enforcement in SDK boot, Build switches and reload", async () => {
		const { childRef, root } = await fixture();
		const provider = await harness();
		let readOnlyHint = true;
		const callTool = vi.fn<McpClientConnection["callTool"]>(async () => ({
			content: [{ type: "text", text: "trusted MCP evidence" }],
		}));
		const listPrompts = vi.fn<McpClientConnection["listPrompts"]>(async () => ({ prompts: [] }));
		const listResources = vi.fn<McpClientConnection["listResources"]>(async () => ({ resources: [] }));
		const connection: McpClientConnection = {
			getServerVersion: () => ({ name: "fake", version: "1" }),
			listTools: async () => ({
				tools: [
					{
						name: "read_note",
						description: "Read a note",
						inputSchema: { type: "object" },
						annotations: { readOnlyHint },
					},
					{
						name: "write_note",
						description: "Write a note",
						inputSchema: { type: "object" },
						annotations: { readOnlyHint: false },
					},
				],
			}),
			listResources,
			readResource: async () => ({ contents: [] }),
			listPrompts,
			getPrompt: async () => ({ messages: [] }),
			callTool,
			close: async () => {},
		};
		const connect = vi.spyOn(DefaultMcpClientFactory.prototype, "connect").mockResolvedValue(connection);
		writeFileSync(
			join(root, "mcp.json"),
			JSON.stringify({
				servers: {
					trusted: {
						command: "fake",
						lifecycle: "eager",
						trustedReads: { tools: ["read_note"] },
						directTools: true,
					},
					untrusted: { command: "never-start", lifecycle: "eager" },
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			sessionManager: await open(childRef),
			model: provider.getModel(),
			authStorage: provider.authStorage,
			modelRegistry: provider.session.modelRegistry,
			settingsManager: provider.settingsManager,
			resourceLoader: provider.session.resourceLoader,
			tools: ["mcp", "mcp__trusted__read_note", "write"],
		});
		sdkSessions.push(session);
		expect(session.isReviewDiscussion).toBe(true);
		expect(session.getActiveToolNames()).toEqual(["mcp"]);
		expect(connect.mock.calls.map(([server]) => server.id)).toEqual(["trusted"]);
		expect(listPrompts).not.toHaveBeenCalled();
		expect(listResources).not.toHaveBeenCalled();
		const gateway = session.state.tools.find((tool) => tool.name === "mcp")!;
		await gateway.execute("trusted", { action: "call", server: "trusted", tool: "read_note" });
		expect(callTool).toHaveBeenCalledOnce();
		for (const args of [
			{ action: "call", server: "trusted", tool: "write_note" },
			{ action: "connect", server: "untrusted" },
			{ action: "read_resource", server: "trusted", resourceUri: "fake:note" },
			{ action: "set_enabled", server: "trusted", enabled: false },
			{ action: "get_prompt", server: "trusted", prompt: "injection" },
		] satisfies JsonObject[])
			await expect(gateway.execute("denied", args)).rejects.toThrow("read-only");
		readOnlyHint = false;
		await expect(
			gateway.execute("metadata-changed", { action: "call", server: "trusted", tool: "read_note" }),
		).rejects.toThrow();
		expect(callTool).toHaveBeenCalledOnce();
		await session.setAgentMode("plan");
		await session.setAgentMode("build");
		expect(connect.mock.calls.map(([server]) => server.id)).toEqual(["trusted"]);
		await session.reload();
		expect(connect.mock.calls.map(([server]) => server.id)).toEqual(["trusted", "trusted"]);
		expect(session.getActiveToolNames()).toEqual(["mcp"]);
		expect(listPrompts).not.toHaveBeenCalled();

		// An external owner may have already started an untrusted server. A new
		// discussion must neither inherit that owner's trust nor shut its services down.
		const supplied = session.getMcpManager()!;
		await supplied.connectServer("untrusted");
		const beforeServers = supplied.listServers();
		const disposeSupplied = vi.spyOn(supplied, "dispose");
		const connectionsBefore = connect.mock.calls.length;
		const isolated = await fixture();
		const created = await createAgentSession({
			cwd: isolated.root,
			agentDir: isolated.root,
			sessionManager: await open(isolated.childRef),
			model: provider.getModel(),
			authStorage: provider.authStorage,
			modelRegistry: provider.session.modelRegistry,
			settingsManager: provider.settingsManager,
			resourceLoader: provider.session.resourceLoader,
			mcpManager: supplied,
			tools: ["mcp"],
		});
		sdkSessions.push(created.session);
		expect(created.session.getMcpManager()).not.toBe(supplied);
		await created.session.setAgentMode("plan");
		await created.session.setAgentMode("build");
		await created.session.reload();
		created.session.dispose();
		await created.session.waitForClosed();
		expect(disposeSupplied).not.toHaveBeenCalled();
		expect(supplied.listServers()).toEqual(beforeServers);
		expect(connect.mock.calls).toHaveLength(connectionsBefore);
	});
});
