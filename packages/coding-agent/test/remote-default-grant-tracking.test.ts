import { describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { authorizeIrohRemoteClient, hashIrohRemotePairingSecret } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { parseIrohRemoteHelloLine } from "../src/core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	IROH_REMOTE_ALPN,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../src/core/remote/iroh/protocol.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteHostState,
	parseIrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";

const WORKSPACE = { name: "volt", path: "/workspace" };
const CODING_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;
/** The default grant as persisted by daemons that predate the current default. */
const LEGACY_SNAPSHOT = "read,bash,edit,write,web_search,grep,find,ls,subagent,subagent_registry,mcp";

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

describe("default grant tracking: runtime policy semantics", () => {
	it("exposes the plan-mode research tools to default-grant remote sessions", () => {
		// #153: phone-hosted sessions must not be a worse research environment
		// than the TUI — the vetted git/gh inspection tool and language-server
		// reads belong in the default remote grant.
		const policy = resolveIrohRemoteRuntimeToolPolicy({
			clientAllowTools: DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			daemonAllowTools: null,
		});
		expect(policy.tools).toContain("inspect");
		expect(policy.tools).toContain("lsp");
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
