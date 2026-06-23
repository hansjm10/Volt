import { describe, expect, test, vi } from "vitest";
import type { ExtensionBindings, PromptOptions } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ResolvedCommand } from "../src/core/extensions/types.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	getIrohRemoteRpcFilterResult,
	sanitizeIrohRemoteOutbound,
} from "../src/core/remote/iroh/index.ts";
import { createLoopbackRpcTransportPair, type RpcExtensionUIRequest } from "../src/core/rpc/index.ts";
import type { Skill } from "../src/core/skills.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { createInProcessRpcClient } from "../src/modes/rpc/in-process-rpc-client.ts";
import { createIrohRemoteCloseDeferringRpcTransport } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../src/modes/rpc/rpc-transport-client.ts";

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

	test("promptAndWait waits for prompt response before resolving on agent_end", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		pair.server.onLine((line) => {
			const command = parseCommandLine(line);
			pair.server.write({ type: "agent_end" });
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

	test("promptAndWait resolves when a successful prompt response follows agent_end", async () => {
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		let command: { id: string; type: string } | undefined;
		pair.server.onLine((line) => {
			command = parseCommandLine(line);
			pair.server.write({ type: "agent_end" });
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
			await expect(eventsPromise).resolves.toEqual([{ type: "agent_end" }]);
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
});

describe("Iroh remote RPC filter", () => {
	test("allows native UI action discovery while keeping invocation and legacy local commands blocked", () => {
		for (const type of ["get_ui_capabilities", "get_ui_actions"]) {
			const command = { id: `${type}-1`, type };
			expect(getIrohRemoteRpcFilterResult(JSON.stringify(command))).toEqual({
				allowed: true,
				command,
			});
		}

		for (const type of [
			"invoke_ui_action",
			"get_messages",
			"get_commands",
			"switch_session",
			"get_available_models",
			"set_model",
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
					success: true,
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

	test("exposes native UI action discovery and local invocation capability", async () => {
		const dispose = vi.fn(async () => {});
		const runtimeHost = createRuntimeHost(dispose);
		const client = await createInProcessRpcClient(runtimeHost);

		try {
			await expect(client.getUiCapabilities()).resolves.toEqual({
				protocolVersion: 1,
				features: ["ui_actions.v1", "ui_action_invocation.v1"],
				maxActions: 200,
				maxDescriptorBytes: 65_536,
			});
			await expect(client.getUiActions("all")).resolves.toEqual([]);
			await expect(client.invokeUiAction("review.uncommitted", { args: {} })).rejects.toThrow(
				"UI action not available: review.uncommitted",
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

			expect(actions).toHaveLength(4);
			expect(actions.map((action) => action.id)).toEqual([
				expect.stringMatching(/^extension\.command\.ec_[a-f0-9]{12}_1$/),
				expect.stringMatching(/^extension\.command\.ec_[a-f0-9]{12}_2$/),
				expect.stringMatching(/^prompt\.template\.pt_[a-f0-9]{12}_1$/),
				expect.stringMatching(/^skill\.sk_[a-f0-9]{12}_1$/),
			]);
			expect(actions.map((action) => action.slash?.name)).toEqual([
				"deploy:1",
				"deploy:2",
				"fix-tests",
				"skill:debugger",
			]);
			expect(actions.map((action) => action.source)).toEqual(["extension", "extension", "prompt", "skill"]);
			expect(actions.map((action) => action.category)).toEqual(["extension", "extension", "prompt", "skill"]);
			expect(actions.every((action) => action.remoteSafe)).toBe(true);
			expect(actions.every((action) => action.enabled)).toBe(true);
			expect(actions[0].sourceScope).toBe("project");
			expect(actions[0].sourceOrigin).toBe("top-level");
			expect(actions[0].sourceLabel).toBe("Project");
			expect(actions[2].sourceLabel).toBe("User");
			expect(actions[3].sourceLabel).toBe("Package");
			expect(actions[0].args).toEqual([
				expect.objectContaining({ name: "arguments", type: "string", completion: "commandArguments" }),
			]);
			expect(actions[2].args).toEqual([
				expect.objectContaining({ name: "arguments", type: "string", hint: "paste failing test output" }),
			]);
			expect(await client.getUiActions("primary")).toEqual([]);

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
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.(true);
		});
		const resources = {
			commands: [createCommand("deploy", "deploy", "Deploy", sourceInfo)],
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

	test("queues prompt-like action invocation while streaming", async () => {
		const sourceInfo = createSourceInfo("/Users/jordan/project/.volt/agent/prompts/fix-tests.md");
		const prompt = vi.fn(async (_message: string, options?: PromptOptions) => {
			options?.preflightResult?.(true);
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
			const [action] = await client.getUiActions("all");
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
			options?.preflightResult?.(true);
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
			const [staleAction] = await client.getUiActions("all");
			if (!staleAction) {
				throw new Error("expected extension action");
			}
			resources.commands.splice(0, 1, createCommand("release", "release", "Release", sourceInfo));

			await expect(client.invokeUiAction(staleAction.id, { args: { arguments: "prod" } })).rejects.toThrow(
				`UI action not available: ${staleAction.id}`,
			);

			const [freshAction] = await client.getUiActions("all");
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
		commands?: ResolvedCommand[];
		isStreaming?: boolean;
		prompt?: (message: string, options?: PromptOptions) => Promise<void>;
		prompts?: PromptTemplate[];
		skills?: Skill[];
	} = {},
): AgentSessionRuntime {
	return {
		session: {
			bindExtensions: vi.fn(bindExtensions),
			subscribe: vi.fn(() => () => {}),
			agent: {
				subscribe: vi.fn(() => () => {}),
			},
			model: undefined,
			thinkingLevel: "off",
			isStreaming: resources.isStreaming ?? false,
			isCompacting: false,
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
					options?.preflightResult?.(true);
				}),
			extensionRunner: {
				getRegisteredCommands: vi.fn(() => resources.commands ?? []),
			},
			promptTemplates: resources.prompts ?? [],
			resourceLoader: {
				getSkills: vi.fn(() => ({ skills: resources.skills ?? [], diagnostics: [] })),
			},
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose,
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
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
): ResolvedCommand {
	return {
		name,
		invocationName,
		description,
		sourceInfo,
		getArgumentCompletions: vi.fn(() => []),
		handler: vi.fn(async () => {}),
	};
}
