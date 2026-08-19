import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, fauxAssistantMessage, type Model, type ThinkingLevelMap } from "@hansjm10/volt-ai";
import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, ExtensionBindings, PromptOptions } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ResolvedCommand } from "../src/core/extensions/types.ts";
import {
	AGENT_MODE_ACTION_ID,
	CONTEXT_COMPACT_ACTION_ID,
	PLAN_CHANGE_ACTION_ID,
	PLAN_DISCARD_ACTION_ID,
	PLAN_EXECUTE_ACTION_ID,
	REVIEW_BRANCH_ACTION_ID,
	REVIEW_COMMIT_ACTION_ID,
	REVIEW_EXPORT_FEEDBACK_ACTION_ID,
	REVIEW_FEEDBACK_ACTION_ID,
	REVIEW_FIX_ACTION_ID,
	REVIEW_PR_ACTION_ID,
	REVIEW_PUBLISH_ACTION_ID,
	REVIEW_RERUN_ACTION_ID,
	REVIEW_UNCOMMITTED_ACTION_ID,
	RUN_CANCEL_ACTION_ID,
	SESSION_NEW_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_ACTION_ID,
	THINKING_FAST_MODE_ACTION_ID,
} from "../src/core/host-actions.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemotePresetAccess,
	getStaticIrohRemoteRpcFilterResult as getIrohRemoteRpcFilterResult,
	sanitizeIrohRemoteOutbound,
} from "../src/core/remote/iroh/index.ts";
import {
	createLoopbackRpcTransportPair,
	type RpcExtensionUIRequest,
	type RpcLineHandler,
	type RpcTransport,
	type RpcUiActionStateChangedEvent,
} from "../src/core/rpc/index.ts";
import type { Skill } from "../src/core/skills.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { createInProcessRpcClient } from "../src/modes/rpc/in-process-rpc-client.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../src/modes/rpc/rpc-transport-client.ts";
import { createTestModel } from "./iroh-stream-doubles.ts";

describe("loopback RPC transport", () => {
	test("buffers writes until a peer line handler attaches and preserves JSON string separators", () => {
		const pair = createLoopbackRpcTransportPair();
		const receivedLines: string[] = [];

		pair.client.write({ text: "a\u2028b\u2029c" });
		pair.server.onLine((line) => {
			receivedLines.push(line);
		});

		expect(receivedLines).toEqual([JSON.stringify({ text: "a\u2028b\u2029c" })]);
	});

	test("closing one endpoint notifies the peer input", () => {
		const pair = createLoopbackRpcTransportPair();
		const closeHandler = vi.fn();
		pair.server.onClose?.(closeHandler);

		pair.client.close();

		expect(closeHandler).toHaveBeenCalledOnce();
	});
});

describe("RpcTransportClient", () => {
	test("sends typed commands and receives non-response events over a transport", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		const events: Array<{ type: string }> = [];
		client.onEvent((event) => {
			events.push(event);
		});
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: { commands: [] },
			});
			pair.server.write({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hello" });
		});

		await client.start();

		await expect(client.getCommands()).resolves.toEqual([]);
		expect(events).toEqual([{ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hello" }]);

		await client.stop();
	});

	test("drops stale deltas after transport stop and restart", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client, closeTransportOnStop: false });
		const events: Array<{ type: string }> = [];
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		client.onEvent((event) => events.push(event));

		try {
			await client.start();
			pair.server.write({
				type: "message_start",
				stream: { epoch: 1, seq: 0 },
				message: fauxAssistantMessage([], { timestamp: 0 }),
			});
			expect(events).toHaveLength(1);

			await client.stop();
			await client.start();
			pair.server.write({
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			});

			expect(events).toHaveLength(1);
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining("[stream-projection:rpc-client] delta_position_gap"),
				expect.objectContaining({ code: "delta_position_gap" }),
			);
		} finally {
			await client.stop();
			pair.client.close();
			stderr.mockRestore();
		}
	});

	test("exposes typed wrappers for documented session RPC commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		const commands: Array<Record<string, unknown>> = [];
		const session = {
			current: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			firstMessage: "hello",
			messageCount: 2,
			modifiedAt: "2026-01-01T00:01:00.000Z",
			sessionId: "session-1",
			sessionName: "Initial",
		};
		const transcript = {
			sessionId: "session-1",
			items: [{ id: "entry-1", role: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
			hasMore: false,
			nextBeforeEntryId: null,
		};
		pair.server.onLine((line) => {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.id !== "string" || typeof parsed.type !== "string") {
				throw new Error("command must include id and type");
			}
			commands.push(parsed);
			switch (parsed.type) {
				case "list_sessions":
					pair.server.write({
						id: parsed.id,
						type: "response",
						command: parsed.type,
						success: true,
						data: { sessions: [session] },
					});
					break;
				case "switch_session_by_id":
					pair.server.write({
						id: parsed.id,
						type: "response",
						command: parsed.type,
						success: true,
						data: { cancelled: false },
					});
					break;
				case "get_transcript":
					pair.server.write({
						id: parsed.id,
						type: "response",
						command: parsed.type,
						success: true,
						data: transcript,
					});
					break;
				default:
					throw new Error(`unexpected command: ${parsed.type}`);
			}
		});

		await client.start();
		try {
			await expect(client.listSessions()).resolves.toEqual([session]);
			await expect(client.switchSessionById("session-2")).resolves.toEqual({ cancelled: false });
			await expect(client.getTranscript({ limit: 10, beforeEntryId: "entry-2" })).resolves.toEqual(transcript);
			expect(commands).toEqual([
				expect.objectContaining({ type: "list_sessions" }),
				expect.objectContaining({ type: "switch_session_by_id", sessionId: "session-2" }),
				expect.objectContaining({ type: "get_transcript", limit: 10, beforeEntryId: "entry-2" }),
			]);
		} finally {
			await client.stop();
		}
	});

	test("sends typed durable review acknowledgment commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		let command: Record<string, unknown> | undefined;
		pair.server.onLine((line) => {
			command = JSON.parse(line) as Record<string, unknown>;
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: { runId: "review:test", acknowledgedAt: 123 },
			});
		});

		await client.start();
		try {
			await expect(client.acknowledgeReview("review:test")).resolves.toEqual({
				runId: "review:test",
				acknowledgedAt: 123,
			});
			expect(command).toMatchObject({ type: "acknowledge_review", runId: "review:test" });
		} finally {
			await client.stop();
		}
	});

	test("rejects unsuccessful responses for void commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "Session name cannot be empty",
			});
		});

		await client.start();
		try {
			await expect(client.setSessionName("")).rejects.toThrow("Session name cannot be empty");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait rejects unsuccessful prompt responses", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "prompt preflight failed",
			});
		});

		await client.start();
		try {
			await expect(client.promptAndWait("hi", undefined, 50)).rejects.toThrow("prompt preflight failed");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait waits for prompt response before resolving on agent_settled", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({ type: "agent_settled" });
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: "prompt preflight failed",
			});
		});

		await client.start();
		try {
			await expect(client.promptAndWait("hi", undefined, 50)).rejects.toThrow("prompt preflight failed");
		} finally {
			await client.stop();
		}
	});

	test("promptAndWait ignores agent_settled events that predate prompt acceptance", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		let command: { id: string; type: string } | undefined;
		pair.server.onLine((line) => {
			command = parseCommandLine(line);
			pair.server.write({ type: "agent_settled" });
		});

		await client.start();
		try {
			let resolved = false;
			const eventsPromise = client.promptAndWait("/extension-command", undefined, 100).then((events) => {
				resolved = true;
				return events;
			});

			await Promise.resolve();
			expect(resolved).toBe(false);

			const acceptedCommand = command;
			if (!acceptedCommand) {
				throw new Error("prompt command was not sent");
			}
			pair.server.write({
				id: acceptedCommand.id,
				type: "response",
				command: acceptedCommand.type,
				success: true,
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			pair.server.write({ type: "agent_settled" });
			await expect(eventsPromise).resolves.toEqual([{ type: "agent_settled" }, { type: "agent_settled" }]);
		} finally {
			await client.stop();
		}
	});

	test("waitForIdle resolves immediately when the session is already idle", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: { isStreaming: false },
			});
		});

		await client.start();
		try {
			await expect(client.waitForIdle(100)).resolves.toBeUndefined();
		} finally {
			await client.stop();
		}
	});

	test("rejects in-flight requests when the transport closes", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		await client.start();

		const statePromise = client.getState();
		pair.server.close();

		await expect(statePromise).rejects.toThrow("RPC transport closed");
	});

	test("fails pending and future requests when inbound JSON is malformed", async () => {
		const transport = new ManualRpcTransport();
		const client = new RpcTransportClient({ transport, requestTimeoutMs: 10_000 });
		await client.start();

		try {
			const stateErrorPromise = client.getState().catch((error: unknown) => error);
			const commandsErrorPromise = client.getCommands().catch((error: unknown) => error);
			expect(transport.writes).toHaveLength(2);

			const malformedLine = `{"bad":"${"x".repeat(256)}-tail`;
			transport.emitLine(malformedLine);

			const [stateError, commandsError] = await Promise.all([stateErrorPromise, commandsErrorPromise]);
			if (!(stateError instanceof Error)) {
				throw new Error("expected state request to reject with an Error");
			}
			expect(commandsError).toBe(stateError);
			expect(stateError.message).toContain("Malformed inbound RPC JSON:");
			expect(stateError.message).toContain("Bad line preview:");
			expect(stateError.message).toContain('"{\\"bad\\":\\"');
			expect(stateError.message).not.toContain("-tail");

			await expect(client.getState()).rejects.toBe(stateError);
		} finally {
			await client.stop();
		}
	});

	test("fails pending and future requests when inbound JSON is not an RPC message", async () => {
		const invalidLines = [
			JSON.stringify("log"),
			JSON.stringify([]),
			JSON.stringify({}),
			JSON.stringify({ type: 1, payload: "x".repeat(256), tail: "should-not-appear" }),
		];

		for (const invalidLine of invalidLines) {
			const transport = new ManualRpcTransport();
			const client = new RpcTransportClient({ transport, requestTimeoutMs: 10_000 });
			const events: Array<{ type: string }> = [];
			client.onEvent((event) => {
				events.push(event);
			});
			await client.start();

			try {
				const stateErrorPromise = client.getState().catch((error: unknown) => error);
				const commandsErrorPromise = client.getCommands().catch((error: unknown) => error);
				expect(transport.writes).toHaveLength(2);

				transport.emitLine(invalidLine);

				const [stateError, commandsError] = await Promise.all([stateErrorPromise, commandsErrorPromise]);
				if (!(stateError instanceof Error)) {
					throw new Error("expected state request to reject with an Error");
				}
				expect(commandsError).toBe(stateError);
				expect(stateError.message).toContain("Invalid inbound RPC message: expected object with string type");
				expect(stateError.message).toContain("Bad line preview:");
				expect(stateError.message).not.toContain("should-not-appear");
				expect(events).toEqual([]);

				await expect(client.getState()).rejects.toBe(stateError);
			} finally {
				await client.stop();
			}
		}
	});

	test("fails pending and future requests when inbound responses are malformed or unknown", async () => {
		const invalidResponses: Array<{
			createResponse: (pendingId: string) => Record<string, unknown>;
			expectedMessage: string;
		}> = [
			{
				createResponse: () => ({ type: "response", command: "get_state", success: true }),
				expectedMessage: "Invalid inbound RPC response: expected string id",
			},
			{
				createResponse: () => ({ type: "response", id: 1, command: "get_state", success: true }),
				expectedMessage: "Invalid inbound RPC response: expected string id",
			},
			{
				createResponse: () => ({ type: "response", id: "unknown-request", command: "get_state", success: true }),
				expectedMessage: 'Invalid inbound RPC response: unknown id "unknown-request"',
			},
			{
				createResponse: (pendingId) => ({ type: "response", id: pendingId, success: true }),
				expectedMessage: "Invalid inbound RPC response: expected string command",
			},
			{
				createResponse: (pendingId) => ({ type: "response", id: pendingId, command: "get_state" }),
				expectedMessage: "Invalid inbound RPC response: expected boolean success",
			},
			{
				createResponse: (pendingId) => ({ type: "response", id: pendingId, command: "get_state", success: false }),
				expectedMessage: "Invalid inbound RPC response: expected string error",
			},
		];

		for (const { createResponse, expectedMessage } of invalidResponses) {
			const transport = new ManualRpcTransport();
			const client = new RpcTransportClient({ transport, requestTimeoutMs: 10_000 });
			const events: Array<{ type: string }> = [];
			client.onEvent((event) => {
				events.push(event);
			});
			await client.start();

			try {
				const stateErrorPromise = client.getState().catch((error: unknown) => error);
				const commandsErrorPromise = client.getCommands().catch((error: unknown) => error);
				expect(transport.writes).toHaveLength(2);

				transport.emitLine(JSON.stringify(createResponse(getWrittenCommandId(transport, 0))));

				const [stateError, commandsError] = await Promise.all([stateErrorPromise, commandsErrorPromise]);
				if (!(stateError instanceof Error)) {
					throw new Error("expected state request to reject with an Error");
				}
				expect(commandsError).toBe(stateError);
				expect(stateError.message).toContain(expectedMessage);
				expect(stateError.message).toContain("Bad line preview:");
				expect(events).toEqual([]);

				await expect(client.getState()).rejects.toBe(stateError);
			} finally {
				await client.stop();
			}
		}
	});

	test("disposing a subagent drops its message-delta accumulator", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		const events: Array<Record<string, unknown>> = [];
		client.onEvent((event) => {
			events.push(event as unknown as Record<string, unknown>);
		});
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			// Mirror the host: every disposal path emits a terminal
			// subagent_disposed frame before the command response.
			if (command.type === "subagent_dispose") {
				pair.server.write({ type: "subagent_disposed", subagentId: "sa_1" });
			}
			pair.server.write({ id: command.id, type: "response", command: command.type, success: true });
		});
		await client.start();

		try {
			const message = {
				role: "assistant",
				content: [],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				stopReason: "stop",
				timestamp: 0,
			};
			// Seed the subagent stream's accumulator, then dispose mid-message so
			// no message_end/subagent_end ever crosses the wire.
			pair.server.write({
				type: "subagent_event",
				subagentId: "sa_1",
				event: { type: "message_start", message },
			});
			await client.disposeSubagent("sa_1");

			// A late slim frame finds no accumulator: it passes through untouched
			// instead of being rebuilt from retained (leaked) state.
			pair.server.write({
				type: "subagent_event",
				subagentId: "sa_1",
				event: {
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
				},
			});
			const last = events.at(-1) as { event?: Record<string, unknown> } | undefined;
			if (!last?.event) {
				throw new Error("expected a trailing subagent_event");
			}
			expect(last.event.type).toBe("message_update");
			expect("message" in last.event).toBe(false);
		} finally {
			await client.stop();
		}
	});
});

describe("Iroh remote RPC filter", () => {
	test("preserves the invocation id when the installed RPC grant is stale", async () => {
		const pair = createLoopbackRpcTransportPair();
		const responses: Array<Record<string, unknown>> = [];
		const onRpcGrantStale = vi.fn();
		pair.client.onLine((line) => {
			responses.push(JSON.parse(line) as Record<string, unknown>);
		});
		const transport = createIrohRemoteFilteredRpcTransport({
			transport: pair.server,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			isRpcGrantCurrent: () => false,
			onRpcGrantStale,
		});
		transport.onLine(() => {
			throw new Error("stale invocation must not reach RPC mode");
		});

		pair.client.write({
			id: "invoke-stale-grant",
			type: "invoke_ui_action",
			action: SESSION_NEW_ACTION_ID,
		});

		await vi.waitFor(() => {
			expect(responses).toContainEqual({
				id: "invoke-stale-grant",
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: "RPC grant is stale; reconnect",
			});
			expect(onRpcGrantStale).toHaveBeenCalledOnce();
		});
	});

	test("allows native UI action discovery and dynamic invocation while keeping local commands blocked", () => {
		for (const type of ["get_ui_capabilities", "get_ui_actions"]) {
			const command = { id: `${type}-1`, type };
			expect(getIrohRemoteRpcFilterResult(JSON.stringify(command))).toEqual({
				allowed: true,
				command,
			});
		}

		const invocation = {
			id: "invoke-1",
			type: "invoke_ui_action",
			action: "extension.command.ec_a1b2c3d4e5f6_1",
			args: { arguments: "prod" },
		};
		expect(getIrohRemoteRpcFilterResult(JSON.stringify(invocation))).toEqual({
			allowed: true,
			command: invocation,
		});
		const completion = {
			id: "completion-1",
			type: "get_ui_action_completions",
			action: "extension.command.ec_a1b2c3d4e5f6_1",
			argument: "arguments",
			prefix: "pr",
		};
		expect(getIrohRemoteRpcFilterResult(JSON.stringify(completion))).toEqual({
			allowed: true,
			command: completion,
		});
		for (const action of [
			SESSION_NEW_ACTION_ID,
			RUN_CANCEL_ACTION_ID,
			THINKING_FAST_MODE_ACTION_ID,
			REVIEW_UNCOMMITTED_ACTION_ID,
			REVIEW_BRANCH_ACTION_ID,
			REVIEW_PR_ACTION_ID,
			REVIEW_COMMIT_ACTION_ID,
			REVIEW_FIX_ACTION_ID,
			REVIEW_FEEDBACK_ACTION_ID,
			REVIEW_RERUN_ACTION_ID,
			REVIEW_PUBLISH_ACTION_ID,
		]) {
			const builtInInvocation = {
				id: `${action}-1`,
				type: "invoke_ui_action",
				action,
			};
			expect(getIrohRemoteRpcFilterResult(JSON.stringify(builtInInvocation))).toEqual({
				allowed: true,
				command: builtInInvocation,
			});
		}
		for (const action of [CONTEXT_COMPACT_ACTION_ID, SESSION_RENAME_ACTION_ID, REVIEW_EXPORT_FEEDBACK_ACTION_ID]) {
			expect(
				getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${action}-1`, type: "invoke_ui_action", action })),
			).toEqual({
				allowed: false,
				response: {
					id: `${action}-1`,
					type: "response",
					command: "invoke_ui_action",
					success: false,
					error: `UI action not available over remote host: ${action}`,
				},
			});
			expect(
				getIrohRemoteRpcFilterResult(
					JSON.stringify({
						id: `${action}-completion-1`,
						type: "get_ui_action_completions",
						action,
						argument: "arguments",
					}),
				),
			).toEqual({
				allowed: false,
				response: {
					id: `${action}-completion-1`,
					type: "response",
					command: "get_ui_action_completions",
					success: false,
					error: `UI action not available over remote host: ${action}`,
				},
			});
		}
		for (const action of ["review.pr.extra", "review.commitment"]) {
			expect(
				getIrohRemoteRpcFilterResult(
					JSON.stringify({ id: `${action}-1`, type: "invoke_ui_action", action, args: {} }),
				),
			).toEqual({
				allowed: false,
				response: {
					id: `${action}-1`,
					type: "response",
					command: "invoke_ui_action",
					success: false,
					error: `UI action not available over remote host: ${action}`,
				},
			});
		}

		for (const type of ["get_messages"]) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${type}-1`, type }))).toEqual({
				allowed: false,
				response: {
					id: `${type}-1`,
					type: "response",
					command: type,
					success: false,
					error: "unsupported_remote_command",
				},
			});
		}
		for (const type of ["get_available_models", "set_model", "set_thinking_level"]) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${type}-1`, type }))).toEqual({
				allowed: true,
				command: { id: `${type}-1`, type },
			});
		}
		for (const type of [
			"get_commands",
			"switch_session",
			"cycle_model",
			"cycle_thinking_level",
			"bash",
			"export_html",
		]) {
			expect(getIrohRemoteRpcFilterResult(JSON.stringify({ id: `${type}-1`, type }))).toEqual({
				allowed: false,
				response: {
					id: `${type}-1`,
					type: "response",
					command: type,
					success: false,
					error: `RPC command not allowed over remote host: ${type}`,
				},
			});
		}
	});

	test("sanitizes native UI action descriptor responses for remote output", () => {
		const workspacePath = "/Users/jordan/private-project";
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				id: "actions-1",
				type: "response",
				command: "get_ui_actions",
				success: true,
				data: {
					actions: [
						{
							schemaVersion: 1,
							id: "extension.command.ec_1",
							label: `Deploy from ${workspacePath}/services/api`,
							description: `Run ${workspacePath}/.volt/agent/extensions/deploy.ts`,
							source: "extension",
							sourceScope: "project",
							sourceOrigin: "top-level",
							sourceLabel: `Project extension at ${workspacePath}/.volt/agent/extensions`,
							category: "extension",
							presentation: {
								kind: "palette",
								group: `${workspacePath}/groups/deploy`,
							},
							args: [
								{
									name: "arguments",
									type: "string",
									hint: `Use ${workspacePath}/deploy/config.json`,
								},
							],
							enabled: true,
							remoteSafe: true,
							slash: {
								name: "deploy",
								example: `/deploy ${workspacePath}/targets/prod`,
							},
							filePath: `${workspacePath}/.volt/agent/extensions/deploy.ts`,
							sourceInfo: {
								path: `${workspacePath}/.volt/agent/extensions/deploy.ts`,
								baseDir: `${workspacePath}/.volt/agent/extensions`,
							},
						},
					],
				},
			},
			{ workspacePath, remoteWorkspacePath: "/workspace" },
		);

		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain(workspacePath);
		expect(serialized).not.toContain("private-project");
		expect(serialized).toContain("/workspace");
	});

	test("passes model catalog responses through the remote outbound sanitizer intact", () => {
		const workspacePath = "/Users/jordan/private-project";
		const model = createTestModel("model-one");
		const sanitized = sanitizeIrohRemoteOutbound(
			{
				id: "models-1",
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [model] },
			},
			{ workspacePath, remoteWorkspacePath: "/workspace" },
		);

		expect(sanitized).toEqual({
			id: "models-1",
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: [model] },
		});
	});
});

describe("runRpcMode", () => {
	test("aborts startup extension UI waits when the transport closes", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const startupRequest = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
			pair.client.onLine((line) => {
				const event = JSON.parse(line) as RpcExtensionUIRequest;
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					resolve(event);
				}
			});
		});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			await uiContext.confirm("Startup", "Continue?");
		});
		const modePromise = runRpcMode(runtimeHost, { transport: pair.server, exitProcess: false });
		void modePromise.catch(() => {});

		await startupRequest;
		pair.client.close();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("defers startup closes until queued Iroh commands drain", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const responses: Array<Record<string, unknown>> = [];
		let finishStartup = () => {};
		const startupBlock = new Promise<void>((resolve) => {
			finishStartup = resolve;
		});
		pair.client.onLine((line) => {
			responses.push(JSON.parse(line) as Record<string, unknown>);
		});
		const runtimeHost = createRuntimeHost(dispose, async () => {
			await startupBlock;
		});
		const transport = createIrohRemoteFilteredRpcTransport({
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: pair.server,
				waitForPromptCompletion: () => Promise.resolve(),
			}),
		});
		const modePromise = runRpcMode(runtimeHost, { transport, exitProcess: false });
		void modePromise.catch(() => {});
		let modeSettled = false;
		void modePromise.then(
			() => {
				modeSettled = true;
			},
			() => {
				modeSettled = true;
			},
		);

		await Promise.resolve();
		pair.client.write({ id: "queued-state", type: "get_state" });
		pair.client.close();
		await Promise.resolve();

		expect(modeSettled).toBe(false);
		finishStartup();

		await expect(modePromise).resolves.toBeUndefined();
		expect(responses).toContainEqual(
			expect.objectContaining({
				id: "queued-state",
				type: "response",
				command: "get_state",
				success: true,
			}),
		);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("defers startup closes until filtered Iroh rejections drain", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const responses: Array<Record<string, unknown>> = [];
		let finishStartup = () => {};
		const startupBlock = new Promise<void>((resolve) => {
			finishStartup = resolve;
		});
		pair.client.onLine((line) => {
			responses.push(JSON.parse(line) as Record<string, unknown>);
		});
		const runtimeHost = createRuntimeHost(dispose, async () => {
			await startupBlock;
		});
		const transport = createIrohRemoteFilteredRpcTransport({
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: pair.server,
				waitForPromptCompletion: () => Promise.resolve(),
			}),
		});
		const modePromise = runRpcMode(runtimeHost, { transport, exitProcess: false });
		void modePromise.catch(() => {});
		let modeSettled = false;
		void modePromise.then(
			() => {
				modeSettled = true;
			},
			() => {
				modeSettled = true;
			},
		);

		await Promise.resolve();
		pair.client.write({ id: "missing-type" });
		pair.client.close();
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					id: "missing-type",
					type: "response",
					command: "unknown",
					success: false,
				}),
			);
		});
		await Promise.resolve();

		expect(modeSettled).toBe(false);
		finishStartup();

		await expect(modePromise).resolves.toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("does not defer startup closes without queued Iroh commands", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const startupRequest = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
			pair.client.onLine((line) => {
				const event = JSON.parse(line) as RpcExtensionUIRequest;
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					resolve(event);
				}
			});
		});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			await uiContext.confirm("Startup", "Continue?");
		});
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: pair.server,
			waitForPromptCompletion: () => Promise.resolve(),
		});
		const modePromise = runRpcMode(runtimeHost, { transport, exitProcess: false });
		void modePromise.catch(() => {});

		await startupRequest;
		pair.client.close();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("does not wait for agent completion after handled UI action responses", async () => {
		const pair = createLoopbackRpcTransportPair();
		let waitedForCompletion = false;
		const transport = createIrohRemoteCloseDeferringRpcTransport({
			transport: pair.server,
			waitForPromptCompletion: () => {
				waitedForCompletion = true;
				return new Promise(() => {});
			},
		});
		let closed = false;
		transport.onLine(() => {});
		transport.onClose?.(() => {
			closed = true;
		});

		const action = "extension.command.ec_a1b2c3d4e5f6_1";
		pair.client.write({ id: "invoke-1", type: "invoke_ui_action", action, args: { arguments: "prod" } });
		pair.client.close();
		await Promise.resolve();
		expect(closed).toBe(false);

		transport.write({
			id: "invoke-1",
			type: "response",
			command: "invoke_ui_action",
			success: true,
			data: { action, status: "handled" },
		});
		await vi.waitFor(() => expect(closed).toBe(true));
		expect(waitedForCompletion).toBe(false);
	});

	test("sanitizes malformed unknown command responses", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const responses: Array<Record<string, unknown>> = [];
		pair.client.onLine((line) => {
			responses.push(JSON.parse(line) as Record<string, unknown>);
		});
		const runtimeHost = createRuntimeHost(dispose);
		const modePromise = runRpcMode(runtimeHost, { transport: pair.server, exitProcess: false });

		pair.client.write({ id: 1, type: "get_state" });
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					command: "get_state",
					success: false,
					error: 'Invalid RPC command payload: "id" must be a string',
				}),
			);
		});

		const stateResponse = responses.find((event) => event.command === "get_state");
		expect(stateResponse).toBeDefined();
		expect(stateResponse).not.toHaveProperty("id");

		pair.client.write({ id: 1, type: "unknown_rpc" });
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					command: "unknown_rpc",
					success: false,
					error: "Unknown command: unknown_rpc",
				}),
			);
		});

		const response = responses.find((event) => event.command === "unknown_rpc");
		expect(response).toBeDefined();
		expect(response).not.toHaveProperty("id");

		pair.client.write({ id: "missing-type" });
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					id: "missing-type",
					type: "response",
					command: "unknown",
					success: false,
					error: "Unknown command: unknown",
				}),
			);
		});

		pair.client.write({ id: "number-type", type: 1 });
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					id: "number-type",
					type: "response",
					command: "unknown",
					success: false,
					error: "Unknown command: unknown",
				}),
			);
		});

		pair.client.write(null as unknown as object);
		await vi.waitFor(() => {
			expect(responses).toContainEqual(
				expect.objectContaining({
					type: "response",
					command: "unknown",
					success: false,
					error: "Unknown command: unknown",
				}),
			);
		});

		pair.client.close();
		await expect(modePromise).resolves.toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("allows remote-safe UI action invocation over Iroh filtered transport", async () => {
		const pair = createLoopbackRpcTransportPair();
		const dispose = vi.fn(async () => {});
		const sourceInfo = createSourceInfo("/Users/jordan/project/.volt/agent/extensions/deploy.ts");
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.({ success: true, outcome: "admitted" });
		});
		const repo = createTestGitRepo(["feature/login"]);
		const runtimeHost = createRuntimeHost(dispose, async () => {}, {
			commands: [
				createCommand("deploy", "deploy", "Deploy", sourceInfo),
				createCommand("unsafe", "unsafe", "Unsafe side effect", sourceInfo, false),
			],
			cwd: repo,
			isStreaming: true,
			newSession: vi.fn(async () => ({ cancelled: false })),
			prompts: [
				{
					name: "fix-tests",
					description: "Fix failing tests",
					argumentHint: "failure output",
					content: "Fix $ARGUMENTS",
					filePath: "/Users/jordan/project/.volt/agent/prompts/fix-tests.md",
					sourceInfo,
				},
			],
			skills: [
				{
					name: "debugger",
					description: "Debug issues",
					filePath: "/Users/jordan/project/.volt/agent/skills/debugger/SKILL.md",
					baseDir: "/Users/jordan/project/.volt/agent/skills/debugger",
					sourceInfo,
					disableModelInvocation: false,
				},
			],
			prompt,
		});
		const transport = createIrohRemoteFilteredRpcTransport({
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			transport: createIrohRemoteCloseDeferringRpcTransport({
				transport: pair.server,
				waitForPromptCompletion: () => Promise.resolve(),
			}),
		});
		const modePromise = runRpcMode(runtimeHost, {
			allowUiActionInvocation: true,
			exitProcess: false,
			requireRemoteSafeUiActions: true,
			transport,
		});
		const client = new RpcTransportClient({ transport: pair.client });
		await client.start();

		try {
			await expect(client.prompt("/unsafe now")).rejects.toThrow(
				"Extension command is not available over remote host: /unsafe",
			);
			expect(prompt).not.toHaveBeenCalled();
			await expect(client.getUiCapabilities()).resolves.toEqual({
				protocolVersion: 1,
				features: ["ui_actions.v1", "ui_action_invocation.v1", "ui_action_completions.v1"],
				maxActions: 200,
				maxDescriptorBytes: 65_536,
			});
			const actions = await client.getUiActions("all");
			const extensionAction = actions.find((action) => action.source === "extension");
			expect(actions.filter((action) => action.source === "extension")).toHaveLength(1);
			const promptAction = actions.find((action) => action.source === "prompt");
			const skillAction = actions.find((action) => action.source === "skill");
			const newSessionAction = actions.find((action) => action.id === SESSION_NEW_ACTION_ID);
			const cancelAction = actions.find((action) => action.id === RUN_CANCEL_ACTION_ID);
			const fastModeAction = actions.find((action) => action.id === THINKING_FAST_MODE_ACTION_ID);
			const reviewChangesAction = actions.find((action) => action.id === REVIEW_UNCOMMITTED_ACTION_ID);
			const reviewBranchAction = actions.find((action) => action.id === REVIEW_BRANCH_ACTION_ID);
			const reviewPullRequestAction = actions.find((action) => action.id === REVIEW_PR_ACTION_ID);
			const reviewCommitAction = actions.find((action) => action.id === REVIEW_COMMIT_ACTION_ID);
			const reviewFixAction = actions.find((action) => action.id === REVIEW_FIX_ACTION_ID);
			const reviewFeedbackAction = actions.find((action) => action.id === REVIEW_FEEDBACK_ACTION_ID);
			const reviewRerunAction = actions.find((action) => action.id === REVIEW_RERUN_ACTION_ID);
			const reviewPublishAction = actions.find((action) => action.id === REVIEW_PUBLISH_ACTION_ID);
			expect(actions.find((action) => action.id === CONTEXT_COMPACT_ACTION_ID)).toBeUndefined();
			expect(actions.find((action) => action.id === SESSION_RENAME_ACTION_ID)).toBeUndefined();
			expect(actions.find((action) => action.id === REVIEW_EXPORT_FEEDBACK_ACTION_ID)).toBeUndefined();
			if (!extensionAction || !promptAction || !skillAction) {
				throw new Error("expected remote extension, prompt, and skill actions");
			}
			if (
				!newSessionAction ||
				!cancelAction ||
				!fastModeAction ||
				!reviewChangesAction ||
				!reviewBranchAction ||
				!reviewPullRequestAction ||
				!reviewCommitAction ||
				!reviewFixAction ||
				!reviewFeedbackAction ||
				!reviewRerunAction ||
				!reviewPublishAction
			) {
				throw new Error("expected remote-safe built-in actions");
			}
			expect(newSessionAction.remoteSafe).toBe(true);
			expect(cancelAction.remoteSafe).toBe(true);
			expect(fastModeAction).toEqual(
				expect.objectContaining({
					category: "model",
					presentation: expect.objectContaining({ kind: "toggle", group: "Model" }),
					enabled: false,
					remoteSafe: true,
					state: { type: "boolean", value: false, label: "Fast mode disabled" },
				}),
			);
			expect(reviewChangesAction).toEqual(
				expect.objectContaining({
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					requiresConfirmation: true,
					remoteSafe: true,
					slash: { name: "review", example: "/review uncommitted" },
				}),
			);
			expect(reviewBranchAction).toEqual(
				expect.objectContaining({
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					requiresConfirmation: true,
					remoteSafe: true,
					slash: { name: "review", example: "/review branch [base]" },
				}),
			);
			expect(reviewPullRequestAction).toEqual(
				expect.objectContaining({
					description: expect.stringContaining("GitHub credentials and network"),
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					requiresConfirmation: true,
					remoteSafe: true,
				}),
			);
			expect(reviewCommitAction).toEqual(
				expect.objectContaining({
					description: expect.stringContaining("workspace history"),
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					requiresConfirmation: true,
					remoteSafe: true,
				}),
			);
			expect(reviewChangesAction.args?.map((argument) => argument.name)).toEqual([
				"focus",
				"scope",
				"effort",
				"includeOptional",
				"scopeMode",
			]);
			expect(reviewBranchAction.args?.map((argument) => argument.name)).toEqual([
				"base",
				"focus",
				"scope",
				"effort",
				"includeOptional",
				"scopeMode",
			]);
			expect(reviewPullRequestAction.args?.map((argument) => argument.name)).toEqual([
				"number",
				"focus",
				"scope",
				"effort",
				"includeOptional",
				"scopeMode",
			]);
			expect(reviewCommitAction.args?.map((argument) => argument.name)).toEqual([
				"ref",
				"focus",
				"scope",
				"effort",
				"includeOptional",
				"scopeMode",
			]);
			for (const lifecycleAction of [
				reviewFixAction,
				reviewFeedbackAction,
				reviewRerunAction,
				reviewPublishAction,
			]) {
				expect(lifecycleAction).toEqual(
					expect.objectContaining({
						category: "review",
						presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
						remoteSafe: true,
					}),
				);
			}
			await expect(client.getUiActionCompletions(REVIEW_BRANCH_ACTION_ID, "base", "feat")).resolves.toEqual([
				{ value: "feature/login" },
			]);
			expect((await client.getUiActions("palette")).map((action) => action.id)).toEqual([
				SESSION_NEW_ACTION_ID,
				extensionAction.id,
				promptAction.id,
				skillAction.id,
			]);
			await expect(client.getUiActionCompletions(extensionAction.id, "arguments", "pr")).resolves.toEqual([]);
			await expect(client.invokeUiAction(extensionAction.id, { args: { arguments: "prod" } })).resolves.toEqual({
				action: extensionAction.id,
				status: "handled",
			});
			await expect(
				client.invokeUiAction(promptAction.id, {
					args: { arguments: "copy failing output" },
					streamingBehavior: "followUp",
				}),
			).resolves.toEqual({
				action: promptAction.id,
				status: "queued",
				queuedAs: "followUp",
			});
			await expect(
				client.invokeUiAction(skillAction.id, {
					args: { arguments: "inspect crash" },
					streamingBehavior: "followUp",
				}),
			).resolves.toEqual({
				action: skillAction.id,
				status: "queued",
				queuedAs: "followUp",
			});
			await expect(client.invokeUiAction(SESSION_NEW_ACTION_ID, { args: {} })).resolves.toEqual({
				action: SESSION_NEW_ACTION_ID,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
			});
			await expect(client.invokeUiAction(RUN_CANCEL_ACTION_ID, { args: {} })).resolves.toEqual({
				action: RUN_CANCEL_ACTION_ID,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
				message: "Run cancelled",
			});
			await expect(client.invokeUiAction(THINKING_FAST_MODE_ACTION_ID, { args: { enabled: true } })).rejects.toThrow(
				"Fast mode is not available while the agent is streaming",
			);
			await expect(client.invokeUiAction(CONTEXT_COMPACT_ACTION_ID, { args: {} })).rejects.toThrow(
				`UI action not available over remote host: ${CONTEXT_COMPACT_ACTION_ID}`,
			);
			await expect(
				client.getUiActionCompletions(CONTEXT_COMPACT_ACTION_ID, "customInstructions", "preserve"),
			).rejects.toThrow(`UI action not available over remote host: ${CONTEXT_COMPACT_ACTION_ID}`);
			await expect(client.invokeUiAction(REVIEW_PR_ACTION_ID, { args: { number: "--repo" } })).rejects.toThrow(
				"PR number must be a canonical positive decimal no greater than 2147483647.",
			);
			expect(prompt).toHaveBeenCalledTimes(3);
			expect(prompt.mock.calls.map(([message]) => message)).toEqual([
				"/deploy prod",
				"/fix-tests copy failing output",
				"/skill:debugger inspect crash",
			]);
			expect(prompt.mock.calls.map(([, options]) => options?.streamingBehavior)).toEqual([
				undefined,
				"followUp",
				"followUp",
			]);
		} finally {
			await client.stop();
			rmSync(repo, { recursive: true, force: true });
		}
		await expect(modePromise).resolves.toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("createInProcessRpcClient", () => {
	test("runs RPC mode against a runtime in the same process", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose);
		const client = await createInProcessRpcClient(runtimeHost);

		await expect(client.getState()).resolves.toMatchObject({
			thinkingLevel: "off",
			isStreaming: false,
			sessionId: "in-process-session",
			messageCount: 0,
		});

		await client.stop();
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("exposes model catalog, model switching, and thinking level RPC", async () => {
		const dispose = vi.fn(async () => {});
		const modelOne = createTestModel("model-one");
		const modelTwo = createTestModel("model-two");
		const setModel = vi.fn(async () => {});
		const setThinkingLevel = vi.fn();
		const runtimeHost = createRuntimeHost(dispose, async () => {}, {
			model: modelOne,
			availableModels: [modelOne, modelTwo],
			availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
			thinkingLevel: "medium",
			setModel,
			setThinkingLevel,
		});
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			await expect(client.getState()).resolves.toMatchObject({
				thinkingLevel: "medium",
				availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
				model: expect.objectContaining({ id: "model-one" }),
			});
			await expect(client.getAvailableModels()).resolves.toEqual([
				expect.objectContaining({ id: "model-one" }),
				expect.objectContaining({ id: "model-two" }),
			]);
			await expect(client.setModel("anthropic", "model-two", { persistDefault: false })).resolves.toMatchObject({
				provider: "anthropic",
				id: "model-two",
			});
			expect(setModel).toHaveBeenCalledWith(modelTwo, { persistDefault: false });
			await expect(client.getState()).resolves.toMatchObject({
				model: expect.objectContaining({ id: "model-two" }),
			});
			await expect(client.setModel("anthropic", "missing")).rejects.toThrow("Model not found: anthropic/missing");
			await expect(client.setThinkingLevel("low", { persistDefault: false })).resolves.toEqual({ level: "low" });
			expect(setThinkingLevel).toHaveBeenCalledWith("low", { persistDefault: false });
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("exposes active compaction metadata in state", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {}, {
			activeCompaction: { reason: "threshold", startedAt: 1_782_470_400_000 },
			isCompacting: true,
		});
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			await expect(client.getState()).resolves.toMatchObject({
				isCompacting: true,
				activeCompaction: { reason: "threshold", startedAt: 1_782_470_400_000 },
			});
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("exposes native UI action discovery and local invocation capability", async () => {
		const dispose = vi.fn(async () => {});
		const abortRun = vi.fn(async () => {});
		const compact = vi.fn(async () => createCompactionResult());
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const setSessionName = vi.fn();
		const runtimeHost = createRuntimeHost(dispose, async () => {}, {
			abort: abortRun,
			compact,
			isStreaming: true,
			newSession,
			setSessionName,
		});
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			await expect(client.getUiCapabilities()).resolves.toEqual({
				protocolVersion: 1,
				features: ["ui_actions.v1", "ui_action_invocation.v1", "ui_action_completions.v1"],
				maxActions: 200,
				maxDescriptorBytes: 65_536,
			});
			const actions = await client.getUiActions("all");
			expect(actions).toEqual([
				expect.objectContaining({
					id: AGENT_MODE_ACTION_ID,
					label: "Agent mode",
					source: "builtin",
					category: "session",
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: PLAN_EXECUTE_ACTION_ID,
					label: "Execute Plan",
					source: "builtin",
					enabled: false,
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: PLAN_CHANGE_ACTION_ID,
					label: "Change Plan",
					source: "builtin",
					enabled: false,
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: PLAN_DISCARD_ACTION_ID,
					label: "Discard plan",
					source: "builtin",
					enabled: false,
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: SESSION_NEW_ACTION_ID,
					label: "New session",
					source: "builtin",
					category: "session",
					remoteSafe: true,
					slash: { name: SESSION_NEW_SLASH_ALIAS, example: "/clear" },
				}),
				expect.objectContaining({
					id: RUN_CANCEL_ACTION_ID,
					label: "Cancel run",
					source: "builtin",
					enabled: true,
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: CONTEXT_COMPACT_ACTION_ID,
					label: "Compact context",
					source: "builtin",
					remoteSafe: false,
					slash: { name: "compact", example: "/compact" },
				}),
				expect.objectContaining({
					id: SESSION_RENAME_ACTION_ID,
					label: "Rename session",
					source: "builtin",
					remoteSafe: false,
					slash: { name: "name", example: "/name <name>" },
				}),
				expect.objectContaining({
					id: THINKING_FAST_MODE_ACTION_ID,
					label: "Fast mode",
					source: "builtin",
					category: "model",
					presentation: expect.objectContaining({ kind: "toggle", group: "Model" }),
					enabled: false,
					remoteSafe: true,
					state: { type: "boolean", value: false, label: "Fast mode disabled" },
				}),
				expect.objectContaining({
					id: REVIEW_UNCOMMITTED_ACTION_ID,
					label: "Review changes",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					// Detached reviews stay available while the session is streaming.
					enabled: true,
					remoteSafe: true,
					requiresConfirmation: true,
					slash: { name: "review", example: "/review uncommitted" },
				}),
				expect.objectContaining({
					id: REVIEW_BRANCH_ACTION_ID,
					label: "Review branch",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					// Detached reviews stay available while the session is streaming.
					enabled: true,
					remoteSafe: true,
					requiresConfirmation: true,
					slash: { name: "review", example: "/review branch [base]" },
				}),
				expect.objectContaining({
					id: REVIEW_PR_ACTION_ID,
					label: "Review pull request",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					enabled: true,
					remoteSafe: true,
					requiresConfirmation: true,
				}),
				expect.objectContaining({
					id: REVIEW_COMMIT_ACTION_ID,
					label: "Review commit",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					enabled: true,
					remoteSafe: true,
					requiresConfirmation: true,
				}),
				expect.objectContaining({
					id: REVIEW_FIX_ACTION_ID,
					label: "Fix review findings",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: REVIEW_FEEDBACK_ACTION_ID,
					label: "Label review finding",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: REVIEW_RERUN_ACTION_ID,
					label: "Re-run review",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: REVIEW_PUBLISH_ACTION_ID,
					label: "Publish PR review",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
					remoteSafe: true,
				}),
				expect.objectContaining({
					id: REVIEW_EXPORT_FEEDBACK_ACTION_ID,
					label: "Export review feedback",
					source: "builtin",
					category: "review",
					presentation: expect.objectContaining({ kind: "detail", group: "Review" }),
					remoteSafe: false,
				}),
			]);
			expect(
				actions
					.find((action) => action.id === REVIEW_UNCOMMITTED_ACTION_ID)
					?.args?.map((argument) => argument.name),
			).toEqual(["focus", "scope", "effort", "includeOptional", "scopeMode"]);
			expect(
				actions.find((action) => action.id === REVIEW_BRANCH_ACTION_ID)?.args?.map((argument) => argument.name),
			).toEqual(["base", "focus", "scope", "effort", "includeOptional", "scopeMode"]);
			expect(
				actions.find((action) => action.id === REVIEW_PR_ACTION_ID)?.args?.map((argument) => argument.name),
			).toEqual(["number", "focus", "scope", "effort", "includeOptional", "scopeMode"]);
			expect(
				actions.find((action) => action.id === REVIEW_COMMIT_ACTION_ID)?.args?.map((argument) => argument.name),
			).toEqual(["ref", "focus", "scope", "effort", "includeOptional", "scopeMode"]);
			await expect(client.getUiActions("primary")).resolves.toEqual([
				expect.objectContaining({
					id: THINKING_FAST_MODE_ACTION_ID,
					presentation: expect.objectContaining({ kind: "toggle" }),
				}),
				expect.objectContaining({
					id: REVIEW_UNCOMMITTED_ACTION_ID,
					presentation: expect.objectContaining({ kind: "card" }),
				}),
				expect.objectContaining({
					id: REVIEW_BRANCH_ACTION_ID,
					presentation: expect.objectContaining({ kind: "card" }),
				}),
				expect.objectContaining({
					id: REVIEW_PR_ACTION_ID,
					presentation: expect.objectContaining({ kind: "card" }),
				}),
				expect.objectContaining({
					id: REVIEW_COMMIT_ACTION_ID,
					presentation: expect.objectContaining({ kind: "card" }),
				}),
			]);
			await expect(client.getUiActions("palette")).resolves.toEqual([
				expect.objectContaining({
					id: SESSION_NEW_ACTION_ID,
					presentation: expect.objectContaining({ kind: "palette" }),
				}),
				expect.objectContaining({
					id: CONTEXT_COMPACT_ACTION_ID,
					presentation: expect.objectContaining({ kind: "palette" }),
				}),
				expect.objectContaining({
					id: SESSION_RENAME_ACTION_ID,
					presentation: expect.objectContaining({ kind: "palette" }),
				}),
			]);
			await expect(client.invokeUiAction(SESSION_NEW_ACTION_ID, { args: {} })).resolves.toEqual({
				action: SESSION_NEW_ACTION_ID,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
			});
			expect(newSession).toHaveBeenCalledWith({
				assertConversationGenerationCurrent: expect.any(Function),
			});
			await expect(client.invokeUiAction(RUN_CANCEL_ACTION_ID, { args: {} })).resolves.toEqual({
				action: RUN_CANCEL_ACTION_ID,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
				message: "Run cancelled",
			});
			expect(abortRun).toHaveBeenCalledOnce();
			await expect(
				client.invokeUiAction(CONTEXT_COMPACT_ACTION_ID, { args: { customInstructions: "preserve decisions" } }),
			).resolves.toEqual({
				action: CONTEXT_COMPACT_ACTION_ID,
				status: "completed",
				stateChanged: true,
				actionsChanged: true,
				message: "Context compacted",
			});
			expect(compact).toHaveBeenCalledWith("preserve decisions", expect.any(Function));
			await expect(client.invokeUiAction(SESSION_RENAME_ACTION_ID, { args: { name: "  D.2  " } })).resolves.toEqual({
				action: SESSION_RENAME_ACTION_ID,
				status: "completed",
				stateChanged: true,
				message: "Session name set: D.2",
			});
			expect(setSessionName).toHaveBeenCalledWith("D.2");
			// Detached reviews are admitted even while the agent is streaming; in
			// this environment the preflight then fails at target resolution.
			await expect(client.invokeUiAction(REVIEW_UNCOMMITTED_ACTION_ID, { args: {} })).rejects.toThrow(
				"Not inside a git repository.",
			);
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("invokes native Fast mode independently from thinking", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {}, {
			model: createModel({ reasoning: true }),
			thinkingLevel: "high",
		});
		const client = await createInProcessRpcClient(runtimeHost);
		const fastStates: RpcUiActionStateChangedEvent["state"][] = [];
		client.onEvent((event) => {
			if (event.type === "ui_action_state_changed") fastStates.push(event.state);
		});

		try {
			const actions = await client.getUiActions("all");
			expect(actions.find((action) => action.id === THINKING_FAST_MODE_ACTION_ID)).toEqual(
				expect.objectContaining({
					enabled: true,
					state: { type: "boolean", value: false, label: "Fast mode disabled" },
				}),
			);

			await expect(
				client.invokeUiAction(THINKING_FAST_MODE_ACTION_ID, { args: { enabled: true } }),
			).resolves.toEqual({
				action: THINKING_FAST_MODE_ACTION_ID,
				status: "completed",
				state: { type: "boolean", value: true, label: "Fast mode enabled" },
				stateChanged: true,
				actionsChanged: true,
				message: "Fast mode enabled. Priority processing may cost more.",
			});
			await expect(client.getState()).resolves.toMatchObject({ thinkingLevel: "high" });
			expect(
				(await client.getUiActions("all")).find((action) => action.id === THINKING_FAST_MODE_ACTION_ID),
			).toEqual(
				expect.objectContaining({
					state: { type: "boolean", value: true, label: "Fast mode enabled" },
				}),
			);

			await client.setThinkingLevel("medium");
			await expect(client.getState()).resolves.toMatchObject({ thinkingLevel: "medium" });
			expect(
				(await client.getUiActions("all")).find((action) => action.id === THINKING_FAST_MODE_ACTION_ID),
			).toEqual(
				expect.objectContaining({
					state: { type: "boolean", value: true, label: "Fast mode enabled" },
				}),
			);

			await expect(
				client.invokeUiAction(THINKING_FAST_MODE_ACTION_ID, { args: { enabled: false } }),
			).resolves.toEqual({
				action: THINKING_FAST_MODE_ACTION_ID,
				status: "completed",
				state: { type: "boolean", value: false, label: "Fast mode disabled" },
				stateChanged: true,
				actionsChanged: true,
				message: "Fast mode disabled",
			});
			await expect(client.getState()).resolves.toMatchObject({ thinkingLevel: "medium" });
			expect(fastStates).toEqual([
				{ type: "boolean", value: true, label: "Fast mode enabled" },
				{ type: "boolean", value: false, label: "Fast mode disabled" },
			]);
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("routes review action invocation through RPC built-in actions", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {}, { cwd: tmpdir() });
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			expect(actions.find((action) => action.id === REVIEW_UNCOMMITTED_ACTION_ID)).toEqual(
				expect.objectContaining({
					enabled: true,
					presentation: expect.objectContaining({ kind: "card", group: "Review" }),
					requiresConfirmation: true,
					remoteSafe: true,
				}),
			);
			await expect(client.invokeUiAction(REVIEW_UNCOMMITTED_ACTION_ID, { args: {} })).rejects.toThrow(
				"Not inside a git repository.",
			);
			await expect(client.invokeUiAction(REVIEW_BRANCH_ACTION_ID, { args: { base: "main" } })).rejects.toThrow(
				"Not inside a git repository.",
			);
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("projects sanitized native UI actions for extension commands, prompt templates, and skills", async () => {
		const sensitiveRoot = "/Users/jordan/private-project";
		const projectSourceInfo = createSourceInfo(`${sensitiveRoot}/.volt/agent/extensions/deploy.ts`, {
			scope: "project",
		});
		const userSourceInfo = createSourceInfo(`${sensitiveRoot}/.volt/agent/prompts/fix-tests.md`, {
			scope: "user",
		});
		const packageSourceInfo = createSourceInfo(`${sensitiveRoot}/.volt/agent/skills/debugger/SKILL.md`, {
			origin: "package",
		});
		const commands: ResolvedCommand[] = [
			createCommand("deploy", "deploy:1", `Deploy from ${sensitiveRoot}/one`, projectSourceInfo),
			createCommand("deploy", "deploy:2", "Deploy the second target", projectSourceInfo),
		];
		const prompts: PromptTemplate[] = [
			{
				name: "fix-tests",
				description: `Fix tests using ${sensitiveRoot}/logs/failure.log`,
				argumentHint: "paste failing test output",
				content: `Prompt body should not leak ${sensitiveRoot}/prompt-body`,
				filePath: `${sensitiveRoot}/.volt/agent/prompts/fix-tests.md`,
				sourceInfo: userSourceInfo,
			},
		];
		const skills: Skill[] = [
			{
				name: "debugger",
				description: `Debug issues without exposing ${sensitiveRoot}/skills/debugger/SKILL.md`,
				filePath: `${sensitiveRoot}/.volt/agent/skills/debugger/SKILL.md`,
				baseDir: `${sensitiveRoot}/.volt/agent/skills/debugger`,
				sourceInfo: packageSourceInfo,
				disableModelInvocation: false,
			},
		];
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {}, { commands, prompts, skills });
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			const builtinActions = actions.filter((action) => action.source === "builtin");
			const dynamicActions = actions.filter((action) => action.source !== "builtin");

			expect(builtinActions.map((action) => action.id)).toEqual([
				AGENT_MODE_ACTION_ID,
				PLAN_EXECUTE_ACTION_ID,
				PLAN_CHANGE_ACTION_ID,
				PLAN_DISCARD_ACTION_ID,
				SESSION_NEW_ACTION_ID,
				RUN_CANCEL_ACTION_ID,
				CONTEXT_COMPACT_ACTION_ID,
				SESSION_RENAME_ACTION_ID,
				THINKING_FAST_MODE_ACTION_ID,
				REVIEW_UNCOMMITTED_ACTION_ID,
				REVIEW_BRANCH_ACTION_ID,
				REVIEW_PR_ACTION_ID,
				REVIEW_COMMIT_ACTION_ID,
				REVIEW_FIX_ACTION_ID,
				REVIEW_FEEDBACK_ACTION_ID,
				REVIEW_RERUN_ACTION_ID,
				REVIEW_PUBLISH_ACTION_ID,
				REVIEW_EXPORT_FEEDBACK_ACTION_ID,
			]);
			expect(dynamicActions).toHaveLength(4);
			expect(dynamicActions.map((action) => action.id)).toEqual([
				expect.stringMatching(/^extension\.command\.ec_[a-f0-9]{12}_1$/),
				expect.stringMatching(/^extension\.command\.ec_[a-f0-9]{12}_2$/),
				expect.stringMatching(/^prompt\.template\.pt_[a-f0-9]{12}_1$/),
				expect.stringMatching(/^skill\.sk_[a-f0-9]{12}_1$/),
			]);
			expect(dynamicActions.map((action) => action.slash?.name)).toEqual([
				"deploy:1",
				"deploy:2",
				"fix-tests",
				"skill:debugger",
			]);
			expect(dynamicActions.map((action) => action.source)).toEqual(["extension", "extension", "prompt", "skill"]);
			expect(dynamicActions.map((action) => action.category)).toEqual(["extension", "extension", "prompt", "skill"]);
			expect(dynamicActions.filter((action) => action.source === "extension")).toEqual([
				expect.objectContaining({
					presentation: { kind: "palette", group: "Extensions" },
					args: [expect.objectContaining({ name: "arguments", type: "string", completion: "commandArguments" })],
				}),
				expect.objectContaining({
					presentation: { kind: "palette", group: "Extensions" },
					args: [expect.objectContaining({ name: "arguments", type: "string", completion: "commandArguments" })],
				}),
			]);
			expect(dynamicActions.every((action) => action.remoteSafe)).toBe(true);
			expect(dynamicActions.every((action) => action.enabled)).toBe(true);
			expect(dynamicActions[0].sourceScope).toBe("project");
			expect(dynamicActions[0].sourceOrigin).toBe("top-level");
			expect(dynamicActions[0].sourceLabel).toBe("Project");
			expect(dynamicActions[2].sourceLabel).toBe("User");
			expect(dynamicActions[3].sourceLabel).toBe("Package");
			expect(dynamicActions[0].args).toEqual([
				expect.objectContaining({ name: "arguments", type: "string", completion: "commandArguments" }),
			]);
			expect(dynamicActions[2].args).toEqual([
				expect.objectContaining({ name: "arguments", type: "string", hint: "paste failing test output" }),
			]);
			expect(await client.getUiActions("primary")).toEqual([
				expect.objectContaining({ id: THINKING_FAST_MODE_ACTION_ID }),
				expect.objectContaining({ id: REVIEW_UNCOMMITTED_ACTION_ID }),
				expect.objectContaining({ id: REVIEW_BRANCH_ACTION_ID }),
				expect.objectContaining({ id: REVIEW_PR_ACTION_ID }),
				expect.objectContaining({ id: REVIEW_COMMIT_ACTION_ID }),
			]);
			expect((await client.getUiActions("palette")).map((action) => action.id)).toEqual([
				SESSION_NEW_ACTION_ID,
				CONTEXT_COMPACT_ACTION_ID,
				SESSION_RENAME_ACTION_ID,
				...dynamicActions.map((action) => action.id),
			]);

			const serialized = JSON.stringify(actions);
			expect(serialized).not.toContain(sensitiveRoot);
			expect(serialized).not.toContain("prompt-body");
			expect(serialized).not.toContain("filePath");
			expect(serialized).not.toContain("baseDir");
			expect(serialized).not.toContain("sourceInfo");
			expect(serialized).toContain("[redacted path]");
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("invokes discovered extension, prompt template, and skill actions through prompt semantics", async () => {
		const sourceInfo = createSourceInfo("/Users/jordan/project/.volt/agent/extensions/deploy.ts");
		const deployCommand = createCommand("deploy", "deploy", "Deploy", sourceInfo);
		deployCommand.getArgumentCompletions = vi.fn((prefix: string) => [
			{ value: `${prefix}-prod`, label: "Production", description: "Production target" },
		]);
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.({ success: true, outcome: "admitted" });
		});
		const resources = {
			commands: [deployCommand],
			prompts: [
				{
					name: "fix-tests",
					description: "Fix failing tests",
					argumentHint: "failure output",
					content: "Fix $ARGUMENTS",
					filePath: "/Users/jordan/project/.volt/agent/prompts/fix-tests.md",
					sourceInfo,
				},
			],
			skills: [
				{
					name: "debugger",
					description: "Debug issues",
					filePath: "/Users/jordan/project/.volt/agent/skills/debugger/SKILL.md",
					baseDir: "/Users/jordan/project/.volt/agent/skills/debugger",
					sourceInfo,
					disableModelInvocation: false,
				},
			],
			prompt,
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {}, resources);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			const extensionAction = actions.find((action) => action.source === "extension");
			const promptAction = actions.find((action) => action.source === "prompt");
			const skillAction = actions.find((action) => action.source === "skill");
			if (!extensionAction || !promptAction || !skillAction) {
				throw new Error("expected extension, prompt, and skill actions");
			}
			expect(extensionAction.args?.[0]).toEqual(
				expect.objectContaining({ name: "arguments", type: "string", completion: "commandArguments" }),
			);

			await expect(client.getUiActionCompletions(extensionAction.id, "arguments", "pr")).resolves.toEqual([
				{ value: "pr-prod", label: "Production", description: "Production target" },
			]);
			expect(deployCommand.getArgumentCompletions).toHaveBeenCalledWith("pr");
			await expect(client.getUiActionCompletions(promptAction.id, "arguments", "")).resolves.toEqual([]);
			await expect(client.getUiActionCompletions(extensionAction.id, "missing", "")).rejects.toThrow(
				"UI action argument not available: missing",
			);

			await expect(client.invokeUiAction(extensionAction.id, { args: { arguments: "prod" } })).resolves.toEqual({
				action: extensionAction.id,
				status: "handled",
			});
			await expect(
				client.invokeUiAction(promptAction.id, { args: { arguments: "copy failing output" } }),
			).resolves.toEqual({
				action: promptAction.id,
				status: "accepted",
			});
			await expect(client.invokeUiAction(skillAction.id, { args: { arguments: "inspect crash" } })).resolves.toEqual(
				{
					action: skillAction.id,
					status: "accepted",
				},
			);

			expect(prompt).toHaveBeenCalledTimes(3);
			expect(prompt.mock.calls.map(([message]) => message)).toEqual([
				"/deploy prod",
				"/fix-tests copy failing output",
				"/skill:debugger inspect crash",
			]);
			expect(prompt.mock.calls.map(([, options]) => options?.source)).toEqual(["rpc", "rpc", "rpc"]);
			expect(prompt.mock.calls.map(([, options]) => options?.streamingBehavior)).toEqual([
				undefined,
				undefined,
				undefined,
			]);
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("serves git branch completions for the review.branch base argument", async () => {
		const repo = createTestGitRepo(["feature/login", "zeta"]);
		const noRepoDir = mkdtempSync(join(tmpdir(), "volt-rpc-norepo-"));
		const runtimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async () => {},
			{ cwd: repo },
		);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			const reviewBranchAction = actions.find((action) => action.id === REVIEW_BRANCH_ACTION_ID);
			expect(reviewBranchAction?.args?.find((argument) => argument.name === "base")).toEqual(
				expect.objectContaining({ name: "base", type: "string", required: false, completion: "gitBranches" }),
			);

			await expect(client.getUiActionCompletions(REVIEW_BRANCH_ACTION_ID, "base", "")).resolves.toEqual([
				{ value: "main" },
				{ value: "feature/login" },
				{ value: "zeta" },
			]);
			await expect(client.getUiActionCompletions(REVIEW_BRANCH_ACTION_ID, "base", "FEAT")).resolves.toEqual([
				{ value: "feature/login" },
			]);
			await expect(client.getUiActionCompletions(REVIEW_BRANCH_ACTION_ID, "missing", "")).rejects.toThrow(
				"UI action argument not available: missing",
			);
			// Built-in args without a completion source serve an empty list.
			await expect(client.getUiActionCompletions(SESSION_RENAME_ACTION_ID, "name", "")).resolves.toEqual([]);
		} finally {
			await client.stop();
		}

		const noRepoRuntimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async () => {},
			{ cwd: noRepoDir },
		);
		const noRepoClient = await createInProcessRpcClient(noRepoRuntimeHost);
		try {
			await expect(noRepoClient.getUiActionCompletions(REVIEW_BRANCH_ACTION_ID, "base", "")).resolves.toEqual([]);
		} finally {
			await noRepoClient.stop();
			rmSync(repo, { recursive: true, force: true });
			rmSync(noRepoDir, { recursive: true, force: true });
		}
	});

	test("queues prompt-like action invocation while streaming", async () => {
		const sourceInfo = createSourceInfo("/Users/jordan/project/.volt/agent/prompts/fix-tests.md");
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.({ success: true, outcome: "admitted" });
		});
		const runtimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async () => {},
			{
				isStreaming: true,
				prompts: [
					{
						name: "fix-tests",
						description: "Fix failing tests",
						argumentHint: "failure output",
						content: "Fix $ARGUMENTS",
						filePath: "/Users/jordan/project/.volt/agent/prompts/fix-tests.md",
						sourceInfo,
					},
				],
				prompt,
			},
		);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			const action = actions.find((candidate) => candidate.source === "prompt");
			if (!action) {
				throw new Error("expected prompt action");
			}
			await expect(client.invokeUiAction(action.id, { args: { arguments: "after current turn" } })).rejects.toThrow(
				"UI action requires streamingBehavior ('steer' or 'followUp') while the agent is streaming",
			);
			await expect(
				client.invokeUiAction(action.id, {
					args: { arguments: "after current turn" },
					streamingBehavior: "followUp",
				}),
			).resolves.toEqual({
				action: action.id,
				status: "queued",
				queuedAs: "followUp",
			});

			expect(prompt).toHaveBeenCalledOnce();
			expect(prompt).toHaveBeenCalledWith(
				"/fix-tests after current turn",
				expect.objectContaining({ source: "rpc", streamingBehavior: "followUp" }),
			);
		} finally {
			await client.stop();
		}
	});

	test("rejects stale UI action ids after the catalog changes", async () => {
		const sourceInfo = createSourceInfo("/Users/jordan/project/.volt/agent/extensions/deploy.ts");
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.({ success: true, outcome: "admitted" });
		});
		const resources = {
			commands: [createCommand("deploy", "deploy", "Deploy", sourceInfo)],
			prompt,
		};
		const runtimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async () => {},
			resources,
		);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const actions = await client.getUiActions("all");
			const staleAction = actions.find((candidate) => candidate.source === "extension");
			if (!staleAction) {
				throw new Error("expected extension action");
			}
			resources.commands.splice(0, 1, createCommand("release", "release", "Release", sourceInfo));

			await expect(client.getUiActionCompletions(staleAction.id, "arguments", "prod")).rejects.toThrow(
				`UI action not available: ${staleAction.id}`,
			);
			await expect(client.invokeUiAction(staleAction.id, { args: { arguments: "prod" } })).rejects.toThrow(
				`UI action not available: ${staleAction.id}`,
			);

			const freshActions = await client.getUiActions("all");
			const freshAction = freshActions.find((candidate) => candidate.source === "extension");
			if (!freshAction) {
				throw new Error("expected refreshed extension action");
			}
			expect(freshAction.id).not.toBe(staleAction.id);
			await expect(client.invokeUiAction(freshAction.id, { args: { arguments: "prod" } })).resolves.toEqual({
				action: freshAction.id,
				status: "handled",
			});
			expect(prompt).toHaveBeenCalledOnce();
			expect(prompt).toHaveBeenCalledWith("/release prod", expect.objectContaining({ source: "rpc" }));
		} finally {
			await client.stop();
		}
	});

	test("sends extension UI responses from in-process clients", async () => {
		let uiContext: ExtensionBindings["uiContext"];
		const runtimeHost = createRuntimeHost(
			vi.fn(async () => {}),
			async (bindings) => {
				uiContext = bindings.uiContext;
			},
		);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			const boundUiContext = uiContext;
			if (!boundUiContext) {
				throw new Error("UI context was not bound");
			}

			let unsubscribe = () => {};
			const requestPromise = new Promise<Extract<RpcExtensionUIRequest, { method: "confirm" }>>((resolve) => {
				unsubscribe = client.onEvent((event) => {
					if (event.type === "extension_ui_request" && event.method === "confirm") {
						unsubscribe();
						resolve(event);
					}
				});
			});
			const confirmPromise = boundUiContext.confirm("Approve", "Continue?");
			const request = await requestPromise;

			await client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: request.id,
				confirmed: true,
			});

			await expect(confirmPromise).resolves.toBe(true);
		} finally {
			await client.stop();
		}
	});

	test("handles extension UI requests emitted while binding startup extensions", async () => {
		const responsePromises: Promise<void>[] = [];
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async (bindings) => {
			const uiContext = bindings.uiContext;
			if (!uiContext) {
				throw new Error("UI context was not bound");
			}
			const confirmed = await uiContext.confirm("Startup", "Continue?", { timeout: 250 });
			if (!confirmed) {
				throw new Error("startup UI was not confirmed");
			}
		});

		const client = await createInProcessRpcClient(runtimeHost, {
			onEvent(event, pendingClient) {
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					const responsePromise = pendingClient.sendExtensionUIResponse({
						type: "extension_ui_response",
						id: event.id,
						confirmed: true,
					});
					responsePromises.push(responsePromise);
					void responsePromise.catch(() => {});
				}
			},
		});

		try {
			await expect(Promise.all(responsePromises)).resolves.toEqual([undefined]);
			await expect(client.getState()).resolves.toMatchObject({ sessionId: "in-process-session" });
		} finally {
			await client.stop();
		}
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("rejects with the startup error when RPC mode cannot bind extensions", async () => {
		const bindError = new Error("bind failed");
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose, async () => {
			throw bindError;
		});

		await expect(createInProcessRpcClient(runtimeHost)).rejects.toBe(bindError);
		expect(dispose).toHaveBeenCalledOnce();
	});
});

class ManualRpcTransport implements RpcTransport {
	readonly writes: object[] = [];
	private readonly lineHandlers = new Set<RpcLineHandler>();

	write(value: object): void {
		this.writes.push(value);
	}

	onLine(handler: RpcLineHandler): () => void {
		this.lineHandlers.add(handler);
		return () => {
			this.lineHandlers.delete(handler);
		};
	}

	close(): void {}

	emitLine(line: string): void {
		for (const handler of this.lineHandlers) {
			handler(line);
		}
	}
}

function getWrittenCommandId(transport: ManualRpcTransport, index: number): string {
	const command = transport.writes[index];
	if (!isTestRecord(command) || typeof command.id !== "string") {
		throw new Error(`expected write ${index} to include a string id`);
	}
	return command.id;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommandLine(line: string): { id: string; type: string } {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("command must be an object");
	}
	const command = parsed as Record<string, unknown>;
	if (typeof command.id !== "string" || typeof command.type !== "string") {
		throw new Error("command must include id and type");
	}
	return { id: command.id, type: command.type };
}

function createRuntimeHost(
	dispose: () => Promise<void>,
	bindExtensions: (bindings: ExtensionBindings) => Promise<void> = async () => {},
	resources: {
		abort?: () => Promise<void>;
		agentDir?: string;
		activeCompaction?: { reason: "manual" | "threshold" | "overflow"; startedAt: number };
		compact?: (customInstructions?: string) => Promise<ReturnType<typeof createCompactionResult>>;
		commands?: ResolvedCommand[];
		cwd?: string;
		isCompacting?: boolean;
		isStreaming?: boolean;
		model?: Model<Api>;
		availableModels?: Model<Api>[];
		availableThinkingLevels?: ThinkingLevel[];
		setModel?: (model: Model<Api>, options?: { persistDefault?: boolean }) => Promise<void>;
		newSession?: (options?: { parentSession?: string }) => Promise<{ cancelled: boolean }>;
		prompt?: (message: string, options?: PromptOptions) => Promise<void>;
		prompts?: PromptTemplate[];
		thinkingLevel?: ThinkingLevel;
		fastModeEnabled?: boolean;
		setThinkingLevel?: (level: ThinkingLevel, options?: { persistDefault?: boolean }) => void;
		setFastModeEnabled?: (enabled: boolean) => void;
		setSessionName?: (name: string) => void;
		skills?: Skill[];
	} = {},
): AgentSessionRuntime {
	let fastModeEnabled = resources.fastModeEnabled ?? false;
	let thinkingLevel = resources.thinkingLevel ?? "off";
	let currentModel = resources.model;
	const sessionListeners = new Set<(event: AgentSessionEvent) => void>();
	const emitSessionEvent = (event: AgentSessionEvent): void => {
		for (const listener of sessionListeners) listener(event);
	};
	const authStorage = {};
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		refreshFromDisk: vi.fn(),
		getAvailable: vi.fn(() => resources.availableModels ?? []),
	};
	const settingsManager = {
		flush: vi.fn(async () => {}),
		getReviewModel: vi.fn(() => undefined),
		isProjectTrusted: vi.fn(() => true),
	};
	const resourceLoader = {
		getSkills: vi.fn(() => ({ skills: resources.skills ?? [], diagnostics: [] })),
	};
	const setThinkingLevel = vi.fn((level: ThinkingLevel, options?: { persistDefault?: boolean }) => {
		thinkingLevel = level;
		resources.setThinkingLevel?.(level, options);
	});
	const setFastModeEnabled = vi.fn((enabled: boolean) => {
		if (enabled === fastModeEnabled) return;
		fastModeEnabled = enabled;
		resources.setFastModeEnabled?.(enabled);
		emitSessionEvent({
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: {
				type: "boolean",
				value: enabled,
				label: enabled ? "Fast mode enabled" : "Fast mode disabled",
			},
		});
	});
	return {
		cwd: resources.cwd ?? tmpdir(),
		services: {
			agentDir: resources.agentDir ?? tmpdir(),
		},
		session: {
			bindExtensions: vi.fn(bindExtensions),
			gitContextProvider: {
				getSnapshot: () => null,
				retainObservation: () => () => undefined,
			},
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				sessionListeners.add(listener);
				return () => sessionListeners.delete(listener);
			}),
			activeToolExecutions: new Map(),
			subscribeRuntimeEvents: vi.fn(() => () => {}),
			get activeCompaction() {
				return resources.activeCompaction;
			},
			get model() {
				return currentModel;
			},
			get thinkingLevel() {
				return thinkingLevel;
			},
			getAvailableThinkingLevels: vi.fn(() => resources.availableThinkingLevels ?? ["off"]),
			setModel: vi.fn(async (model: Model<Api>, options?: { persistDefault?: boolean }) => {
				currentModel = model;
				await resources.setModel?.(model, options);
			}),
			get fastModeEnabled() {
				return fastModeEnabled;
			},
			isStreaming: resources.isStreaming ?? false,
			isBusy: resources.isStreaming ?? false,
			isCompacting: resources.isCompacting ?? false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionFile: undefined,
			sessionId: "in-process-session",
			sessionName: undefined,
			autoCompactionEnabled: true,
			messages: [],
			pendingMessageCount: 0,
			prompt:
				resources.prompt ??
				vi.fn(async (_message: string, options?: PromptOptions) => {
					options?.preflightResult?.({ success: true, outcome: "admitted" });
				}),
			extensionRunner: {
				getRegisteredCommands: vi.fn(() => resources.commands ?? []),
				getCommand: vi.fn((name: string) =>
					(resources.commands ?? []).find((command) => command.invocationName === name || command.name === name),
				),
			},
			sessionManager: {
				flush: vi.fn(async () => {}),
				getCwd: vi.fn(() => resources.cwd ?? tmpdir()),
			},
			promptTemplates: resources.prompts ?? [],
			modelRegistry,
			settingsManager,
			resourceLoader,
			sendCustomMessage: vi.fn(async () => {}),
			abort: resources.abort ?? vi.fn(async () => {}),
			compact: resources.compact ?? vi.fn(async () => createCompactionResult()),
			setThinkingLevel,
			setFastModeEnabled,
			setSessionName: resources.setSessionName ?? vi.fn(() => {}),
		},
		newSession: resources.newSession ?? vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		startRecoveredClientInputs: vi.fn(async () => {}),
		dispose,
		setRebindSession: vi.fn(),
		async runWithStableSession<T>(operation: (stableSession: AgentSession) => Promise<T> | T): Promise<T> {
			return operation((this as unknown as AgentSessionRuntime).session);
		},
	} as unknown as AgentSessionRuntime;
}

function gitInTestRepo(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function createTestGitRepo(branches: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-rpc-branches-"));
	gitInTestRepo(dir, "init", "--initial-branch=main");
	gitInTestRepo(dir, "config", "user.email", "test@example.com");
	gitInTestRepo(dir, "config", "user.name", "Test");
	gitInTestRepo(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "file.txt"), "one\n");
	gitInTestRepo(dir, "add", "file.txt");
	gitInTestRepo(dir, "commit", "-m", "initial");
	for (const branch of branches) {
		gitInTestRepo(dir, "branch", branch);
	}
	return dir;
}

function createCompactionResult() {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

function createSourceInfo(
	path: string,
	options: {
		scope?: SourceInfo["scope"];
		origin?: SourceInfo["origin"];
		source?: string;
	} = {},
): SourceInfo {
	return {
		path,
		source: options.source ?? "local",
		scope: options.scope ?? "project",
		origin: options.origin ?? "top-level",
		baseDir: path.slice(0, path.lastIndexOf("/")),
	};
}

function createCommand(
	name: string,
	invocationName: string,
	description: string,
	sourceInfo: SourceInfo,
	remoteSafe = true,
): ResolvedCommand {
	return {
		name,
		invocationName,
		description,
		remoteSafe,
		sourceInfo,
		getArgumentCompletions: vi.fn(() => []),
		handler: vi.fn(async () => {}),
	};
}

function createModel(options: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap } = {}): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: options.reasoning ?? false,
		thinkingLevelMap: options.thinkingLevelMap,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}
