import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { authorizeIrohRemoteClient, hashIrohRemotePairingSecret } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { parseIrohRemoteHelloLine } from "../src/core/remote/iroh/handshake.ts";
import {
	canonicalizePersistedIrohRemoteAllowTools,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	IROH_REMOTE_ALPN,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../src/core/remote/iroh/protocol.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteHostState,
	parseIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";

const WORKSPACE = { name: "volt", path: "/workspace" };
const CODING_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;
/** The default grant as persisted by daemons that predate the current default. */
const LEGACY_SNAPSHOT = "read,bash,edit,write,web_search,grep,find,ls,subagent,subagent_registry,mcp";
/**
 * The immediate pre-#153 default (no inspect/lsp). Deliberately stays pinned:
 * with no way to distinguish a re-stamped snapshot from an explicit grant that
 * equaled the old default, freezing is the security-conservative reading.
 * Pre-existing pairings re-pair or reset access to start tracking.
 */
const PRE_INSPECT_SNAPSHOT = "read,bash,edit,write,web_search,web_fetch,grep,find,ls,subagent,subagent_registry,mcp";

const RAW_CLIENT_BASE = {
	nodeId: "client-node",
	label: "phone",
	allowedWorkspaces: [],
	rpcGrant: CODING_GRANT,
	pairedAt: 100,
	lastSeenAt: 100,
};

function makeHello(workspace: string, secret?: string) {
	return parseIrohRemoteHelloLine(
		JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace,
			secret,
			clientLabel: "phone",
			clientNodeId: "client-claimed-id",
			conversation: { target: "last" },
		}),
	);
}

function makeState(): IrohRemoteHostState {
	const state = createEmptyIrohRemoteHostState();
	state.workspaces.push({ ...WORKSPACE });
	return state;
}

function parseRawState(raw: Record<string, unknown>): IrohRemoteHostState {
	return parseIrohRemoteHostState(JSON.parse(JSON.stringify({ workspaces: [WORKSPACE], clients: [], ...raw })));
}

function pairClient(state: IrohRemoteHostState, allowTools: string, nodeId = "client-node") {
	const result = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name, "secret"), nodeId, {
		allowTools,
		pairingSecret: "secret",
		pairingExpiresAt: 200,
		workspace: WORKSPACE,
		now: 100,
	});
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result;
}

function reconnectClient(state: IrohRemoteHostState, nodeId = "client-node") {
	const result = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name), nodeId, {
		allowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
		workspace: WORKSPACE,
		now: 200,
	});
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result;
}

describe("default grant tracking: pairing", () => {
	it("creates a tracking client (no persisted allowedTools) for a default-grant pairing", () => {
		const state = makeState();
		const result = pairClient(state, DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(result.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(result.client).not.toHaveProperty("allowedTools");
		expect(state.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("treats a reordered default grant as default at pairing time", () => {
		const state = makeState();
		const result = pairClient(state, DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",").reverse().join(","));
		expect(result.client).not.toHaveProperty("allowedTools");
	});

	it("persists an explicitly customized grant", () => {
		const state = makeState();
		const result = pairClient(state, " grep , read ,read");
		expect(result.client.allowedTools).toBe("grep,read");
		expect(result.allowTools).toBe("grep,read");
	});

	it("persists a deny-all grant as the empty string", () => {
		const state = makeState();
		const result = pairClient(state, "");
		expect(result.client.allowedTools).toBe("");
		expect(result.allowTools).toBe("");
	});

	it("creates a tracking client when consuming a default-intent pairing ticket", () => {
		const state = makeState();
		state.pendingPairingTickets = [
			{
				secretHash: hashIrohRemotePairingSecret("ticket-secret"),
				workspace: WORKSPACE.name,
				rpcGrant: CODING_GRANT,
				createdAt: 1,
				expiresAt: 1_000,
			},
		];
		const result = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name, "ticket-secret"), "client-node", {
			allowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			workspace: WORKSPACE,
			now: 100,
		});
		if (!result.ok) {
			throw new Error(result.error);
		}
		expect(result.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(result.client).not.toHaveProperty("allowedTools");
	});
});

describe("default grant tracking: reconnect", () => {
	it("does not stamp a grant onto a tracking client on reconnect", () => {
		const state = makeState();
		pairClient(state, DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		const result = reconnectClient(state);
		expect(result.allowTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(state.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("preserves a customized grant across reconnects", () => {
		const state = makeState();
		pairClient(state, "read,grep");
		const result = reconnectClient(state);
		expect(result.allowTools).toBe("read,grep");
		expect(state.clients[0]?.allowedTools).toBe("read,grep");
	});

	it("keeps a legacy default snapshot frozen rather than silently widening it", () => {
		const state = parseRawState({ clients: [{ ...RAW_CLIENT_BASE, allowedTools: LEGACY_SNAPSHOT }] });
		const result = reconnectClient(state);
		expect(result.allowTools).toBe(LEGACY_SNAPSHOT);
		expect(state.clients[0]?.allowedTools).toBe(LEGACY_SNAPSHOT);
	});
});

describe("default grant tracking: state load and round-trip", () => {
	it("loads a record without allowedTools as tracking and never materializes the default", () => {
		const state = parseRawState({ clients: [{ ...RAW_CLIENT_BASE }] });
		expect(state.clients[0]).not.toHaveProperty("allowedTools");
		const roundTripped = parseIrohRemoteHostState(JSON.parse(JSON.stringify(state)));
		expect(roundTripped.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("self-heals a snapshot of the current default grant to tracking on load", () => {
		const state = parseRawState({
			clients: [{ ...RAW_CLIENT_BASE, allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS }],
		});
		expect(state.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("preserves a legacy (old-default) snapshot verbatim on load", () => {
		const state = parseRawState({ clients: [{ ...RAW_CLIENT_BASE, allowedTools: LEGACY_SNAPSHOT }] });
		expect(state.clients[0]?.allowedTools).toBe(LEGACY_SNAPSHOT);
	});

	it("keeps the immediate pre-#153 default snapshot pinned rather than inferring tracking", () => {
		const state = parseRawState({ clients: [{ ...RAW_CLIENT_BASE, allowedTools: PRE_INSPECT_SNAPSHOT }] });
		expect(state.clients[0]?.allowedTools).toBe(PRE_INSPECT_SNAPSHOT);
	});

	it("canonicalizes pending pairing tickets on load like client records", () => {
		const state = parseRawState({
			pendingPairingTickets: [
				{
					secretHash: "sha256:default",
					workspace: WORKSPACE.name,
					allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
					rpcGrant: CODING_GRANT,
					createdAt: 1,
					expiresAt: 10,
				},
				{
					secretHash: "sha256:custom",
					workspace: WORKSPACE.name,
					allowedTools: "read",
					rpcGrant: CODING_GRANT,
					createdAt: 1,
					expiresAt: 10,
				},
			],
		});
		expect(state.pendingPairingTickets?.[0]).not.toHaveProperty("allowedTools");
		expect(state.pendingPairingTickets?.[1]?.allowedTools).toBe("read");
	});

	it("applies the same rules to revoked-client records", () => {
		const state = parseRawState({
			revokedClients: [
				{ ...RAW_CLIENT_BASE, allowedTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS, revokedAt: 150 },
				{ ...RAW_CLIENT_BASE, nodeId: "custom-node", allowedTools: "read", revokedAt: 150 },
			],
		});
		expect(state.revokedClients?.[0]).not.toHaveProperty("allowedTools");
		expect(state.revokedClients?.[1]?.allowedTools).toBe("read");
	});
});

describe("default grant tracking: pairing ticket mint", () => {
	async function mint(options: { allowTools?: string }) {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ ...WORKSPACE });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { ...WORKSPACE },
			now: () => 1,
		});
		await engine.pair({
			workspace: WORKSPACE.name,
			irohTicket: "endpoint-ticket",
			secret: "one-time-secret",
			expiresAt: 100,
			...(options.allowTools === undefined ? {} : { allowTools: options.allowTools }),
		});
		const ticket = (await manager.getState()).pendingPairingTickets?.[0];
		expect(ticket).toBeDefined();
		return ticket;
	}

	it("stores default-intent tickets without a resolved allowedTools snapshot", async () => {
		const ticket = await mint({});
		expect(ticket).not.toHaveProperty("allowedTools");
	});

	it("stores customized tickets with the normalized grant", async () => {
		const ticket = await mint({ allowTools: "read, grep" });
		expect(ticket?.allowedTools).toBe("read,grep");
	});
});

describe("default grant tracking: updateClientAccess", () => {
	async function managerWithClient(allowTools: string) {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ ...WORKSPACE });
		const paired = await manager.authorizeClient(makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools,
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			now: 100,
		});
		expect(paired.ok).toBe(true);
		return manager;
	}

	it("persists an explicit customization", async () => {
		const manager = await managerWithClient(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		const result = await manager.updateClientAccess("client-node", 1, {
			allowedTools: "read,grep",
			rpcGrant: CODING_GRANT,
		});
		expect(result.ok).toBe(true);
		expect((await manager.getState()).clients[0]?.allowedTools).toBe("read,grep");
	});

	it("clears the persisted grant when updating back to default semantics", async () => {
		const manager = await managerWithClient("read,grep");
		const result = await manager.updateClientAccess("client-node", 1, {
			allowedTools: createIrohRemotePresetAccess("coding").allowedTools,
			rpcGrant: CODING_GRANT,
		});
		expect(result.ok).toBe(true);
		expect((await manager.getState()).clients[0]).not.toHaveProperty("allowedTools");
	});

	it("persists a deny-all update", async () => {
		const manager = await managerWithClient(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		const result = await manager.updateClientAccess("client-node", 1, {
			allowedTools: createIrohRemotePresetAccess("chat").allowedTools,
			rpcGrant: CODING_GRANT,
		});
		expect(result.ok).toBe(true);
		expect((await manager.getState()).clients[0]?.allowedTools).toBe("");
	});
});

describe("default grant tracking: cross-default upgrades", () => {
	// Synthetic defaults standing in for two releases of the daemon: pairing
	// happens under A, the daemon restarts with the widened default B.
	const DEFAULT_A = "read,grep,ls";
	const DEFAULT_B = "read,grep,ls,inspect";

	it("canonicalizes against the injected default, not the compiled one", () => {
		expect(canonicalizePersistedIrohRemoteAllowTools("ls, grep ,read", DEFAULT_A)).toBeUndefined();
		expect(canonicalizePersistedIrohRemoteAllowTools(DEFAULT_A, DEFAULT_B)).toBe("read,grep,ls");
	});

	it("a tracking client pairs under default A and resolves under default B", () => {
		const state = makeState();
		const paired = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools: DEFAULT_A,
			defaultAllowTools: DEFAULT_A,
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			workspace: WORKSPACE,
			now: 100,
		});
		if (!paired.ok) throw new Error(paired.error);
		expect(paired.allowTools).toBe(DEFAULT_A);
		expect(paired.client).not.toHaveProperty("allowedTools");

		const reconnected = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name), "client-node", {
			allowTools: DEFAULT_B,
			defaultAllowTools: DEFAULT_B,
			workspace: WORKSPACE,
			now: 200,
		});
		if (!reconnected.ok) throw new Error(reconnected.error);
		expect(reconnected.allowTools).toBe(DEFAULT_B);
		expect(state.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("a pinned client keeps its grant across the default change", () => {
		const state = makeState();
		const paired = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools: "read",
			defaultAllowTools: DEFAULT_A,
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			workspace: WORKSPACE,
			now: 100,
		});
		if (!paired.ok) throw new Error(paired.error);
		const reconnected = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name), "client-node", {
			allowTools: DEFAULT_B,
			defaultAllowTools: DEFAULT_B,
			workspace: WORKSPACE,
			now: 200,
		});
		if (!reconnected.ok) throw new Error(reconnected.error);
		expect(reconnected.allowTools).toBe("read");
	});

	it("a snapshot of default A loads as pinned under default B but heals under default A", () => {
		const raw = { workspaces: [WORKSPACE], clients: [{ ...RAW_CLIENT_BASE, allowedTools: DEFAULT_A }] };
		const underB = parseIrohRemoteHostState(JSON.parse(JSON.stringify(raw)), { defaultAllowTools: DEFAULT_B });
		expect(underB.clients[0]?.allowedTools).toBe("read,grep,ls");
		const underA = parseIrohRemoteHostState(JSON.parse(JSON.stringify(raw)), { defaultAllowTools: DEFAULT_A });
		expect(underA.clients[0]).not.toHaveProperty("allowedTools");
	});

	it("runtime policy follows the injected default for tracking grants and freezes pinned ones", () => {
		const tracking = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: DEFAULT_B,
			daemonAllowTools: null,
			defaultAllowTools: DEFAULT_B,
		});
		expect(tracking.tools).toEqual(DEFAULT_B.split(","));
		expect(tracking.allowUnlistedExtensionTools).toBe(true);

		const pinned = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: DEFAULT_A,
			daemonAllowTools: null,
			defaultAllowTools: DEFAULT_B,
		});
		expect(pinned.tools).toEqual(DEFAULT_A.split(","));
		expect(pinned.allowUnlistedExtensionTools).toBe(false);
	});

	it("a default-intent ticket minted under default A grants default B when consumed under B", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ ...WORKSPACE });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { ...WORKSPACE },
			defaultAllowTools: DEFAULT_A,
			allowTools: DEFAULT_A,
			now: () => 1,
		});
		await engine.pair({
			workspace: WORKSPACE.name,
			irohTicket: "endpoint-ticket",
			secret: "one-time-secret",
			expiresAt: 100,
		});
		const state = await manager.getState();
		expect(state.pendingPairingTickets?.[0]).not.toHaveProperty("allowedTools");

		const consumed = authorizeIrohRemoteClient(state, makeHello(WORKSPACE.name, "one-time-secret"), "client-node", {
			allowTools: DEFAULT_B,
			defaultAllowTools: DEFAULT_B,
			workspace: WORKSPACE,
			now: 50,
		});
		if (!consumed.ok) throw new Error(consumed.error);
		expect(consumed.allowTools).toBe(DEFAULT_B);
		expect(consumed.client).not.toHaveProperty("allowedTools");
	});

	it("engine-level injection travels the production pair/reconnect chain", async () => {
		// Injection ONLY at engine construction — pins the engine's constructor
		// resolution, its forwarding into stateManager.authorizeClient, and the
		// manager's authorization path, the exact links production traverses.
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ ...WORKSPACE });
		const engineA = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { ...WORKSPACE },
			defaultAllowTools: DEFAULT_A,
			now: () => 1,
		});
		await engineA.pair({
			workspace: WORKSPACE.name,
			irohTicket: "endpoint-ticket",
			secret: "one-time-secret",
			expiresAt: 100,
		});
		const paired = await engineA.authorizeHello(makeHello(WORKSPACE.name, "one-time-secret"), "client-node");
		if (!paired.ok) throw new Error(paired.error);
		expect(paired.allowTools).toBe(DEFAULT_A);
		expect(paired.client).not.toHaveProperty("allowedTools");

		const engineB = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { ...WORKSPACE },
			defaultAllowTools: DEFAULT_B,
			now: () => 200,
		});
		const reconnected = await engineB.authorizeHello(makeHello(WORKSPACE.name), "client-node");
		if (!reconnected.ok) throw new Error(reconnected.error);
		expect(reconnected.allowTools).toBe(DEFAULT_B);
		expect(reconnected.client).not.toHaveProperty("allowedTools");
	});

	it("manager-level injection fills authorizeClient calls that pass no default", async () => {
		// A reordered DEFAULT_B grant only canonicalizes to tracking against the
		// manager's injected default, so deleting the manager's default-fill
		// (rather than the caller's option) fails this test.
		const manager = new IrohRemoteHostStateManager({
			initialState: createEmptyIrohRemoteHostState(),
			defaultAllowTools: DEFAULT_B,
		});
		await manager.upsertWorkspace({ ...WORKSPACE });
		const paired = await manager.authorizeClient(makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools: DEFAULT_B.split(",").reverse().join(","),
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			now: 100,
		});
		if (!paired.ok) throw new Error(paired.error);
		expect(paired.allowTools).toBe(DEFAULT_B);
		expect(paired.client).not.toHaveProperty("allowedTools");
	});

	it("a per-call defaultAllowTools of undefined does not clobber the manager's default", async () => {
		const manager = new IrohRemoteHostStateManager({
			initialState: createEmptyIrohRemoteHostState(),
			defaultAllowTools: DEFAULT_B,
		});
		await manager.upsertWorkspace({ ...WORKSPACE });
		const paired = await manager.authorizeClient(makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools: DEFAULT_B,
			defaultAllowTools: undefined,
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			now: 100,
		});
		if (!paired.ok) throw new Error(paired.error);
		expect(paired.allowTools).toBe(DEFAULT_B);
		expect(paired.client).not.toHaveProperty("allowedTools");
	});

	it("file-backed state loads canonicalize against the manager's injected default", async () => {
		const dir = await mkdtemp(join(tmpdir(), "volt-grant-tracking-"));
		try {
			const statePath = join(dir, "state.json");
			await writeIrohRemoteHostState(statePath, {
				...createEmptyIrohRemoteHostState(),
				workspaces: [{ ...WORKSPACE }],
				clients: [{ ...RAW_CLIENT_BASE, allowedTools: DEFAULT_A }],
			});
			const underB = new IrohRemoteHostStateManager({ statePath, defaultAllowTools: DEFAULT_B });
			expect((await underB.getState()).clients[0]?.allowedTools).toBe("read,grep,ls");
			const underA = new IrohRemoteHostStateManager({ statePath, defaultAllowTools: DEFAULT_A });
			expect((await underA.getState()).clients[0]).not.toHaveProperty("allowedTools");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	it("updateClientAccess clears a grant that equals the manager's injected default", async () => {
		const manager = new IrohRemoteHostStateManager({
			initialState: createEmptyIrohRemoteHostState(),
			defaultAllowTools: DEFAULT_B,
		});
		await manager.upsertWorkspace({ ...WORKSPACE });
		const paired = await manager.authorizeClient(makeHello(WORKSPACE.name, "secret"), "client-node", {
			allowTools: "read",
			defaultAllowTools: DEFAULT_B,
			pairingSecret: "secret",
			pairingExpiresAt: 200,
			now: 100,
		});
		expect(paired.ok).toBe(true);
		const updated = await manager.updateClientAccess("client-node", 1, {
			allowedTools: "inspect,ls,grep,read",
			rpcGrant: CODING_GRANT,
		});
		expect(updated.ok).toBe(true);
		expect((await manager.getState()).clients[0]).not.toHaveProperty("allowedTools");
	});
});

describe("default grant tracking: runtime policy semantics", () => {
	it("exposes research and Codex image-generation tools to default-grant remote sessions", () => {
		// Phone-hosted sessions use the canonical current default directly: the
		// research surface and image generation must not require a separate grant.
		const policy = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			daemonAllowTools: null,
		});
		expect(policy.tools).toContain("inspect");
		expect(policy.tools).toContain("lsp");
		expect(policy.tools).toContain("image_gen");
	});

	it("keeps the extension-tool wildcard for tracking clients", () => {
		const policy = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			daemonAllowTools: null,
		});
		expect(policy.allowUnlistedExtensionTools).toBe(true);
		expect(policy.tools).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
	});

	it("enforces an exact list without the wildcard for customized clients", () => {
		const policy = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: "read,grep",
			daemonAllowTools: null,
		});
		expect(policy.allowUnlistedExtensionTools).toBe(false);
		expect(policy.tools).toEqual(["read", "grep"]);
	});

	it("keeps deny-all denying every tool", () => {
		const policy = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: "",
			daemonAllowTools: null,
		});
		expect(policy.allowUnlistedExtensionTools).toBe(false);
		expect(policy.tools).toEqual([]);
	});
});
