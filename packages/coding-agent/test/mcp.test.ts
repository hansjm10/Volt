import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { getMcpServerAuthState } from "../src/core/mcp/auth.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { loadMcpConfig } from "../src/core/mcp/config-loader.ts";
import { McpConfigWriter } from "../src/core/mcp/config-writer.ts";
import { createMcpDirectToolDefinitions } from "../src/core/mcp/direct-tools.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import {
	completeMcpOAuthBrowserAuth,
	pollMcpOAuthDeviceAuth,
	startMcpOAuthBrowserAuth,
	startMcpOAuthDeviceAuth,
} from "../src/core/mcp/oauth-flow.ts";
import { McpOAuthStore } from "../src/core/mcp/oauth-store.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import { classifyMcpToolRisk, sanitizeMcpArguments } from "../src/core/mcp/safety.ts";
import type {
	McpClientConnection,
	McpClientFactory,
	McpGatewayExecutionContext,
	McpManagerEvent,
	McpResolvedConfig,
} from "../src/core/mcp/types.ts";
import { tryCreateFileSymlinkSync } from "./symlink-utils.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "volt-mcp-test-"));
}

function createTestConfig(tempDir: string, serverOverrides: Record<string, unknown> = {}): McpResolvedConfig {
	const source = sourceForMcpConfigPath(join(tempDir, "mcp.json"), {
		scope: "user",
		label: "test",
		precedence: 1,
		shared: false,
	});
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { maxOutputBytes: 1024, maxOutputLines: 10 },
			servers: {
				fake: {
					command: "fake-mcp",
					lifecycle: "keep-alive",
					...serverOverrides,
				},
			},
		},
		source,
	);
	return finalizeMcpConfig(merged);
}

function createGatewayContext(): McpGatewayExecutionContext {
	return {
		mode: "rpc",
	};
}

function createFakeFactory(output: string): McpClientFactory {
	const readNoteTool: SdkTool = {
		name: "read_note",
		description: "Read a note",
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
	};
	const updateNoteTool: SdkTool = {
		name: "update_note",
		description: "Update a note",
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: false },
	};
	return {
		connect: async () =>
			({
				getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
				listTools: async () => ({ tools: [readNoteTool, updateNoteTool] }),
				listResources: async () => ({ resources: [] }),
				readResource: async () => ({ contents: [] }),
				listPrompts: async () => ({ prompts: [] }),
				getPrompt: async () => ({ messages: [] }),
				callTool: async ({ name, arguments: args }) => ({
					content: [{ type: "text", text: `${name}:${JSON.stringify(args)}\n${output}` }],
				}),
				close: async () => undefined,
			}) as McpClientConnection,
	};
}

describe("MCP support", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	it("loads user MCP config while gating project MCP config on project trust", () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".volt"), { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ servers: { "user-unique-mcp-test": { command: "user-server" } } }),
		);
		writeFileSync(
			join(cwd, ".volt", "mcp.json"),
			JSON.stringify({ servers: { "project-unique-mcp-test": { command: "project-server" } } }),
		);

		const untrusted = loadMcpConfig({ cwd, agentDir, projectTrusted: false });
		expect(untrusted.servers["user-unique-mcp-test"]).toBeDefined();
		expect(untrusted.servers["project-unique-mcp-test"]).toBeUndefined();
		expect(untrusted.diagnostics.some((diagnostic) => diagnostic.message.includes("project trust"))).toBe(true);

		const trusted = loadMcpConfig({ cwd, agentDir, projectTrusted: true });
		expect(trusted.servers["user-unique-mcp-test"]).toBeDefined();
		expect(trusted.servers["project-unique-mcp-test"]).toBeDefined();
	});

	it("does not let project MCP config inherit user-scope secrets by server-id collision", () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".volt"), { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				servers: {
					"secret-server": {
						command: "user-server",
						env: { API_TOKEN: "$" + "{env:API_TOKEN}" },
						auth: { type: "bearer", token: "$" + "{env:API_TOKEN}" },
					},
				},
			}),
		);
		writeFileSync(
			join(cwd, ".volt", "mcp.json"),
			JSON.stringify({ servers: { "secret-server": { url: "https://project.example/mcp" } } }),
		);

		const config = loadMcpConfig({ cwd, agentDir, projectTrusted: true });
		const server = config.servers["secret-server"];
		expect(server.transport).toBe("streamable-http");
		expect(server.command).toBeUndefined();
		expect(server.env).toEqual({});
		expect(server.auth).toBeUndefined();
	});

	it("discovers tools, records calls, and caches oversized outputs", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const manager = new McpManager({
			config: createTestConfig(tempDir),
			clientFactory: createFakeFactory("x".repeat(1500)),
			metadataCache: new McpMetadataCache({ agentDir: tempDir }),
			outputStore: new McpOutputStore({ agentDir: tempDir, maxOutputBytes: 1024, maxOutputLines: 10 }),
		});

		const connected = await manager.connectServer("fake");
		expect(connected.server.status).toBe("ready");
		expect(connected.server.toolCounts.enabled).toBe(2);

		const searchResult = manager.search("note", 5);
		expect(searchResult.matches.map((match) => `${match.server}.${match.tool}`)).toContain("fake.read_note");

		const callResult = await manager.callTool(
			{ action: "call", server: "fake", tool: "read_note", arguments: { apiKey: "secret", value: 1 } },
			createGatewayContext(),
		);
		expect(callResult.status).toBe("completed");
		expect(callResult.risk).toBe("read");
		expect(callResult.truncation?.truncated).toBe(true);
		expect(callResult.cache?.read).toContain('"read_cache"');
		expect(manager.getServer("fake").recentCalls[0]?.tool).toBe("read_note");

		const cached = await manager.handleGatewayInput(
			{ action: "read_cache", cacheId: callResult.cache?.id, limit: 100 },
			createGatewayContext(),
		);
		expect(cached).toMatchObject({ action: "read_cache", cacheId: callResult.cache?.id, startByte: 0 });
		expect(JSON.stringify(cached)).toContain("read_note");

		const writeCallResult = await manager.callTool(
			{ action: "call", server: "fake", tool: "update_note", arguments: { value: 1 } },
			createGatewayContext(),
		);
		expect(writeCallResult.status).toBe("completed");
		expect(writeCallResult.risk).toBe("write");

		await manager.disconnectServer("fake");
	});

	it("bounds persistent MCP output caches and scopes entries strictly", () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		let now = 1_000;
		const store = new McpOutputStore({
			agentDir: tempDir,
			maxOutputBytes: 8,
			maxOutputLines: 10,
			maxCacheEntryBytes: 1_024,
			maxCacheEntries: 2,
			maxCacheTotalBytes: 2_048,
			now: () => now,
		});
		const first = store.write("first");
		now += 1_000;
		const second = store.write("second");
		now += 1_000;
		const third = store.write("third");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(third).toBeDefined();
		expect(readdirSync(join(tempDir, "mcp", "output"))).toHaveLength(2);
		expect(() => store.read(first ?? "")).toThrow("not found");
		expect(() => store.read(third ?? "", { cursor: "1garbage" })).toThrow("Invalid MCP cache cursor");

		const scoped = new McpOutputStore({ agentDir: tempDir, sessionId: "other-session", now: () => now });
		expect(() => scoped.read(third ?? "")).toThrow("not available in this session");
		const sessionScoped = new McpOutputStore({
			agentDir: tempDir,
			sessionId: "session-a",
			workspaceId: "workspace-a",
			now: () => now,
		});
		const sessionScopedId = sessionScoped.write("session secret");
		const workspaceOnly = new McpOutputStore({ agentDir: tempDir, workspaceId: "workspace-a", now: () => now });
		expect(() => workspaceOnly.read(sessionScopedId ?? "")).toThrow("not available in this session");
		const unscoped = new McpOutputStore({ agentDir: tempDir, now: () => now });
		expect(() => unscoped.read(sessionScopedId ?? "")).toThrow("not available in this session");

		const tooLarge = new McpOutputStore({
			agentDir: tempDir,
			maxOutputBytes: 8,
			maxOutputLines: 10,
			maxCacheEntryBytes: 128,
		});
		const shaped = tooLarge.shapeOutput("x".repeat(1_000));
		expect(shaped.truncation?.truncated).toBe(true);
		expect(shaped.cache).toBeUndefined();
	});

	it("prunes stale and excess MCP metadata cache entries", () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		let now = Date.parse("2026-01-01T00:00:00.000Z");
		const cache = new McpMetadataCache({
			agentDir: tempDir,
			maxServers: 2,
			maxAgeMs: 1_000,
			now: () => now,
		});
		const metadata = { tools: [], resources: [], prompts: [] };
		cache.set("one", { server: "one", ...metadata });
		now += 100;
		cache.set("two", { server: "two", ...metadata });
		now += 100;
		cache.set("three", { server: "three", ...metadata });
		expect(cache.get("one")).toBeUndefined();
		expect(cache.getAll().map((entry) => entry.server)).toEqual(["two", "three"]);

		now += 2_000;
		const reloaded = new McpMetadataCache({
			agentDir: tempDir,
			maxServers: 2,
			maxAgeMs: 1_000,
			now: () => now,
		});
		expect(reloaded.getAll()).toEqual([]);
	});

	it("measures the exact pretty-printed metadata cache payload against the byte cap", () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const cache = new McpMetadataCache({ agentDir: tempDir, maxBytes: 240 });
		cache.set("one", { server: "one", tools: [], resources: [], prompts: [] });

		const cachePath = join(tempDir, "mcp", "metadata-cache.json");
		expect(statSync(cachePath).size).toBeLessThanOrEqual(240);
		expect(cache.get("one")).toBeUndefined();
	});

	it("streams lifecycle events for status changes, tool calls, enablement, and auth", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const progressFactory: McpClientFactory = {
			connect: async () =>
				({
					getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
					listTools: async () => ({
						tools: [
							{
								name: "read_note",
								description: "Read a note",
								inputSchema: { type: "object" },
								annotations: { readOnlyHint: true },
							},
						],
					}),
					listResources: async () => ({ resources: [] }),
					readResource: async () => ({ contents: [] }),
					listPrompts: async () => ({ prompts: [] }),
					getPrompt: async () => ({ messages: [] }),
					callTool: async ({ name }, options) => {
						options.onProgress?.({ progress: 1, total: 2, message: "halfway" });
						return { content: [{ type: "text", text: `${name}:done` }] };
					},
					close: async () => undefined,
				}) as McpClientConnection,
		};
		const manager = new McpManager({
			config: createTestConfig(tempDir),
			clientFactory: progressFactory,
			metadataCache: new McpMetadataCache({ agentDir: tempDir }),
			outputStore: new McpOutputStore({ agentDir: tempDir, maxOutputBytes: 1024, maxOutputLines: 10 }),
			configWriter: new McpConfigWriter({ cwd: tempDir, agentDir: tempDir, projectTrusted: true }),
		});
		const events: McpManagerEvent[] = [];
		const unsubscribe = manager.subscribe((event) => events.push(event));

		await manager.connectServer("fake");
		const statusTrail = events
			.filter((event) => event.type === "mcp_server_status_changed")
			.map((event) => event.server.status);
		expect(statusTrail).toEqual(["connecting", "connected", "discovering", "ready"]);

		events.length = 0;
		await manager.callTool(
			{ action: "call", server: "fake", tool: "read_note", arguments: {} },
			createGatewayContext(),
		);
		expect(events.map((event) => event.type)).toEqual(["mcp_call_start", "mcp_call_update", "mcp_call_end"]);
		const callStart = events[0];
		const callUpdate = events[1];
		const callEnd = events[2];
		if (
			callStart.type !== "mcp_call_start" ||
			callUpdate.type !== "mcp_call_update" ||
			callEnd.type !== "mcp_call_end"
		) {
			throw new Error("unexpected event order");
		}
		expect(callStart.call).toMatchObject({ server: "fake", tool: "read_note", status: "started", risk: "read" });
		expect(callUpdate.progress).toEqual({ progress: 1, total: 2, message: "halfway" });
		expect(callEnd.call).toMatchObject({ id: callStart.call.id, status: "completed" });
		expect(callEnd.call.durationMs).toBeDefined();

		events.length = 0;
		await manager.setServerEnabled("fake", false);
		const eventTypes = events.map((event) => event.type);
		expect(eventTypes).toContain("mcp_servers_changed");
		expect(eventTypes).toContain("mcp_server_status_changed");
		const serversChanged = events.find((event) => event.type === "mcp_servers_changed");
		if (serversChanged?.type !== "mcp_servers_changed") {
			throw new Error("missing servers changed event");
		}
		expect(serversChanged.servers[0]?.enabled).toBe(false);

		events.length = 0;
		manager.cancelServerAuth("fake");
		expect(events).toHaveLength(1);
		const authUpdate = events[0];
		if (authUpdate.type !== "mcp_auth_update") {
			throw new Error("expected auth update event");
		}
		expect(authUpdate).toMatchObject({ serverId: "fake", status: "cancelled" });

		unsubscribe();
		events.length = 0;
		await manager.setServerEnabled("fake", true);
		expect(events).toEqual([]);
		await manager.dispose();
	});

	it("persists enablement overlays and exposes configured direct tools", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const config = createTestConfig(tempDir, { directTools: ["read_note"] });
		const manager = new McpManager({
			config,
			clientFactory: createFakeFactory("direct-output"),
			metadataCache: new McpMetadataCache({ agentDir: tempDir }),
			outputStore: new McpOutputStore({ agentDir: tempDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
			configWriter: new McpConfigWriter({ cwd: tempDir, agentDir: tempDir, projectTrusted: true }),
		});
		await manager.connectServer("fake");

		const tools = await manager.listTools("fake");
		expect(tools.tools.find((tool) => tool.name === "read_note")?.direct).toBe(true);
		const directTools = createMcpDirectToolDefinitions(manager);
		expect(directTools.map((tool) => tool.name)).toEqual(["mcp__fake__read_note"]);
		const directResult = await directTools[0].execute(
			"direct-1",
			{ value: 2 },
			undefined,
			undefined,
			undefined as unknown as Parameters<(typeof directTools)[0]["execute"]>[4],
		);
		const directText = directResult.content[0];
		expect(directText?.type).toBe("text");
		expect(directText?.type === "text" ? directText.text : "").toContain("read_note");

		const changedConfigManager = new McpManager({
			config: createTestConfig(tempDir, { command: "other-fake-mcp", directTools: ["read_note"] }),
			clientFactory: createFakeFactory("direct-output"),
			metadataCache: new McpMetadataCache({ agentDir: tempDir }),
			outputStore: new McpOutputStore({ agentDir: tempDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
		});
		expect(createMcpDirectToolDefinitions(changedConfigManager)).toEqual([]);
		expect(changedConfigManager.search("note").matches).toEqual([]);
		await changedConfigManager.dispose();

		const disabled = await manager.setServerEnabled("fake", false);
		expect(disabled.server.enabled).toBe(false);
		const persistedConfig = JSON.parse(readFileSync(join(tempDir, "mcp.json"), "utf-8")) as {
			servers?: Record<string, { enabled?: boolean }>;
		};
		expect(persistedConfig.servers?.fake?.enabled).toBe(false);
	});

	it("atomically persists MCP config", () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const config = createTestConfig(tempDir);
		const writer = new McpConfigWriter({ cwd: tempDir, agentDir: tempDir, projectTrusted: true });
		const configPath = writer.setServerEnabled(config.servers.fake, false).path;
		const firstInode = statSync(configPath, { bigint: true }).ino;
		writer.setServerDirectTools(config.servers.fake, ["read_note"]);
		const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
			servers?: Record<string, { enabled?: boolean; directTools?: string[] }>;
		};
		expect(persisted.servers?.fake).toEqual({ enabled: false, directTools: ["read_note"] });
		expect(statSync(configPath, { bigint: true }).ino).not.toBe(firstInode);
	});

	it("uses an owner-only POSIX mode for MCP config", (context) => {
		if (process.platform === "win32") {
			context.skip("POSIX permission bits are not supported on Windows");
		}
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const config = createTestConfig(tempDir);
		const writer = new McpConfigWriter({ cwd: tempDir, agentDir: tempDir, projectTrusted: true });
		const configPath = writer.setServerEnabled(config.servers.fake, false).path;

		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});

	it("refuses non-regular MCP config targets without modifying symlink referents", () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const config = createTestConfig(tempDir);
		const writer = new McpConfigWriter({ cwd: tempDir, agentDir: tempDir, projectTrusted: true });
		const configPath = writer.setServerEnabled(config.servers.fake, false).path;
		rmSync(configPath);
		const referent = join(tempDir, "referent.json");
		writeFileSync(referent, '{"doNotOverwrite":true}');
		if (!tryCreateFileSymlinkSync(referent, configPath)) {
			mkdirSync(configPath);
		}
		expect(() => writer.setServerEnabled(config.servers.fake, true)).toThrow("non-regular private file");
		expect(readFileSync(referent, "utf8")).toBe('{"doNotOverwrite":true}');
	});

	it("completes OAuth device-code auth without exposing device secrets", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const config = createTestConfig(tempDir, {
			transport: "streamable-http",
			url: "https://api.example/mcp",
			auth: { type: "oauth", flow: "device", clientId: "volt-test", scope: "repo" },
		});
		const server = config.servers.fake;
		const oauthStore = McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend());
		let tokenPolls = 0;
		const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			expect(init?.redirect).toBe("error");
			const url = String(input);
			if (url.includes("oauth-protected-resource")) {
				return new Response(
					JSON.stringify({
						resource: "https://api.example/mcp",
						authorization_servers: ["https://auth.example"],
						scopes_supported: ["repo"],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("oauth-authorization-server")) {
				return new Response(
					JSON.stringify({
						issuer: "https://auth.example",
						authorization_endpoint: "https://auth.example/authorize",
						token_endpoint: "https://auth.example/token",
						device_authorization_endpoint: "https://auth.example/device",
						response_types_supported: ["code"],
						grant_types_supported: [
							"authorization_code",
							"refresh_token",
							"urn:ietf:params:oauth:grant-type:device_code",
						],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: ["none"],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
			if (url === "https://auth.example/device") {
				expect(body.get("client_id")).toBe("volt-test");
				expect(body.get("resource")).toBe("https://api.example/mcp");
				return new Response(
					JSON.stringify({
						device_code: "secret-device-code",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.example/activate",
						verification_uri_complete: "https://auth.example/activate?user_code=ABCD-EFGH",
						expires_in: 600,
						interval: 1,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url === "https://auth.example/token") {
				tokenPolls++;
				expect(body.get("device_code")).toBe("secret-device-code");
				if (tokenPolls === 1) {
					return new Response(JSON.stringify({ error: "authorization_pending" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({
						access_token: "access-token",
						refresh_token: "refresh-token",
						token_type: "Bearer",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const started = await startMcpOAuthDeviceAuth({ server, store: oauthStore, fetchFn });
		expect(started.result.userCode).toBe("ABCD-EFGH");
		expect(JSON.stringify(started.result)).not.toContain("secret-device-code");
		expect(getMcpServerAuthState(server, process.env, oauthStore)).toBe("required");

		started.pending.nextPollAtMs = Date.now();
		const pending = await pollMcpOAuthDeviceAuth({ server, store: oauthStore, pending: started.pending, fetchFn });
		expect(pending.result.status).toBe("pending");
		expect(pending.pending).toBeDefined();
		const nextPending = pending.pending;
		expect(nextPending).toBeDefined();
		nextPending!.nextPollAtMs = Date.now();
		const completed = await pollMcpOAuthDeviceAuth({ server, store: oauthStore, pending: nextPending!, fetchFn });
		expect(completed.result.status).toBe("authenticated");
		expect(oauthStore.getRecord(server)?.tokens?.access_token).toBe("access-token");
		expect(getMcpServerAuthState(server, process.env, oauthStore)).toBe("authenticated");
	});

	it("rejects non-loopback OAuth browser redirects before discovery", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const server = createTestConfig(tempDir, {
			transport: "streamable-http",
			url: "https://api.example/mcp",
			auth: { type: "oauth", clientId: "volt-test" },
		}).servers.fake;
		let fetched = false;

		await expect(
			startMcpOAuthBrowserAuth({
				server,
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				redirectUrl: "https://attacker.example/callback",
				fetchFn: async () => {
					fetched = true;
					throw new Error("unexpected fetch");
				},
			}),
		).rejects.toThrow("numeric loopback");
		expect(fetched).toBe(false);
	});

	it("rejects OAuth network redirects during discovery", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const server = createTestConfig(tempDir, {
			transport: "streamable-http",
			url: "https://api.example/mcp",
			auth: { type: "oauth", flow: "device", clientId: "volt-test" },
		}).servers.fake;
		let redirectMode: RequestInit["redirect"];

		await expect(
			startMcpOAuthDeviceAuth({
				server,
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				fetchFn: async (_input, init) => {
					redirectMode = init?.redirect;
					return new Response(undefined, {
						status: 307,
						headers: { location: "http://attacker.example/downgrade" },
					});
				},
			}),
		).rejects.toThrow("network redirects are not allowed");
		expect(redirectMode).toBe("error");
	});

	it("requires a stored nonempty exact OAuth browser state before exchanging a code", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const server = createTestConfig(tempDir, {
			transport: "streamable-http",
			url: "https://api.example/mcp",
			auth: { type: "oauth", clientId: "volt-test" },
		}).servers.fake;
		const store = McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend());
		let fetched = false;

		await expect(
			completeMcpOAuthBrowserAuth({
				server,
				store,
				redirectUrl: "http://127.0.0.1:4321/mcp/oauth/callback",
				code: "attacker-code",
				state: "attacker-state",
				fetchFn: async () => {
					fetched = true;
					throw new Error("unexpected fetch");
				},
			}),
		).rejects.toThrow("state mismatch");
		expect(fetched).toBe(false);

		store.patchRecord(server, { state: "expected-state" });
		await expect(
			completeMcpOAuthBrowserAuth({
				server,
				store,
				redirectUrl: "http://127.0.0.1:4321/mcp/oauth/callback",
				code: "attacker-code",
				state: "wrong-state",
				fetchFn: async () => {
					fetched = true;
					throw new Error("unexpected fetch");
				},
			}),
		).rejects.toThrow("state mismatch");
		expect(fetched).toBe(false);
	});

	it("rejects unsafe device verification URLs", async () => {
		const tempDir = makeTempDir();
		tempDirs.push(tempDir);
		const server = createTestConfig(tempDir, {
			transport: "streamable-http",
			url: "https://api.example/mcp",
			auth: { type: "oauth", flow: "device", clientId: "volt-test" },
		}).servers.fake;
		const fetchFn = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) {
				return Response.json({
					resource: "https://api.example/mcp",
					authorization_servers: ["https://auth.example"],
				});
			}
			if (url.includes("oauth-authorization-server")) {
				return Response.json({
					issuer: "https://auth.example",
					authorization_endpoint: "https://auth.example/authorize",
					token_endpoint: "https://auth.example/token",
					device_authorization_endpoint: "https://auth.example/device",
					response_types_supported: ["code"],
					grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			}
			if (url === "https://auth.example/device") {
				return Response.json({
					device_code: "secret-device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "file:///tmp/fake-login.html",
					expires_in: 600,
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		await expect(
			startMcpOAuthDeviceAuth({
				server,
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				fetchFn,
			}),
		).rejects.toThrow("verification URL must use HTTPS");
	});

	it("classifies risks and redacts secret-looking arguments", () => {
		const config = createTestConfig(makeTempDir());
		const server = config.servers.fake;
		expect(server).toBeDefined();
		tempDirs.push(server.source.baseDir);

		expect(classifyMcpToolRisk({ name: "delete_file", description: "", annotations: {} })).toBe("destructive");
		expect(classifyMcpToolRisk({ name: "read_file", description: "", annotations: {} })).toBe("read");
		expect(sanitizeMcpArguments({ apiKey: "secret", nested: { password: "p", keep: "visible" } })).toEqual({
			apiKey: "[redacted]",
			nested: { password: "[redacted]", keep: "visible" },
		});
	});
});
