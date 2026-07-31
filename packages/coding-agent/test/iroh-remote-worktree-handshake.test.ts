import { describe, expect, test } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import {
	createIrohRemoteHandshakeSuccess,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	parseIrohRemoteHandshakeResponseLine,
	parseIrohRemoteHelloLine,
} from "../src/core/remote/iroh/handshake.ts";
import {
	IROH_REMOTE_AGENT_LAUNCH_FEATURE,
	IROH_REMOTE_AGENT_SETTLED_FEATURE,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HOST_FEATURES,
	IROH_REMOTE_PLANNING_STATE_FEATURE,
	IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE,
	IROH_REMOTE_WORKING_DIRECTORIES_FEATURE,
	IROH_REMOTE_WORKTREE_ID_PATTERN,
	IROH_REMOTE_WORKTREES_FEATURE,
	isIrohRemoteWorktreeId,
} from "../src/core/remote/iroh/protocol.ts";
import { createIntegratedConversationHandshakeResponse } from "../src/daemon/handshake-responses.ts";

function parseHello(fields: Record<string, unknown>): IrohRemoteHello {
	return parseIrohRemoteHelloLine(
		JSON.stringify({
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "volt",
			...fields,
		}),
	);
}

function responseLine(fields: Record<string, unknown>): string {
	return JSON.stringify({
		type: "volt_iroh_handshake",
		success: true,
		workspace: "volt",
		hostNodeId: "host-node",
		clientNodeId: "client-node",
		features: [...IROH_REMOTE_HOST_FEATURES],
		...fields,
	});
}

describe("worktrees.v1 capability flag", () => {
	test("worktrees.v1 is advertised as an optional host feature", () => {
		expect(IROH_REMOTE_WORKTREES_FEATURE).toBe("worktrees.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("worktrees.v1");
		expect(IROH_REMOTE_WORKING_DIRECTORIES_FEATURE).toBe("working_directories.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("working_directories.v1");
		expect(IROH_REMOTE_AGENT_SETTLED_FEATURE).toBe("agent_settled.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("agent_settled.v1");
		expect(IROH_REMOTE_SESSION_RUNTIME_STATE_FEATURE).toBe("session_runtime_state.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("session_runtime_state.v1");
		expect(IROH_REMOTE_PLANNING_STATE_FEATURE).toBe("planning_state.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("planning_state.v1");
		expect(IROH_REMOTE_AGENT_LAUNCH_FEATURE).toBe("agent_launch.v1");
		expect([...IROH_REMOTE_HOST_FEATURES]).toContain("agent_launch.v1");
	});

	test("worktrees.v1 is NOT a required handshake feature (old hosts still parse)", () => {
		// A success response advertising only the pre-worktree features must
		// still parse: worktrees.v1 is a gate for clients, not a hard requirement.
		const parsed = parseIrohRemoteHandshakeResponseLine(
			responseLine({
				features: ["multi_streams.v1", "conversation_streams.v1"],
				sessionId: "abc123",
				conversation: { target: "new", sessionId: "abc123", selection: "created" },
			}),
		);
		expect(parsed.success).toBe(true);
	});

	test("worktree id pattern accepts slugs and rejects traversal/uppercase/long ids", () => {
		expect(isIrohRemoteWorktreeId("fix-login")).toBe(true);
		expect(isIrohRemoteWorktreeId("a")).toBe(true);
		expect(isIrohRemoteWorktreeId("a1._-x")).toBe(true);
		expect(isIrohRemoteWorktreeId("a".repeat(64))).toBe(true);
		expect(isIrohRemoteWorktreeId("a".repeat(65))).toBe(false);
		expect(isIrohRemoteWorktreeId("UPPER")).toBe(false);
		expect(isIrohRemoteWorktreeId("-leading")).toBe(false);
		expect(isIrohRemoteWorktreeId(".leading")).toBe(false);
		expect(isIrohRemoteWorktreeId("a/b")).toBe(false);
		expect(isIrohRemoteWorktreeId("../evil")).toBe(false);
		expect(isIrohRemoteWorktreeId("")).toBe(false);
		expect(isIrohRemoteWorktreeId(42)).toBe(false);
		expect(IROH_REMOTE_WORKTREE_ID_PATTERN.test("fix-login")).toBe(true);
	});
});

describe("hello: worktreeId on conversation targets", () => {
	test("accepts worktreeId only on target new", () => {
		expect(parseHello({ conversation: { target: "new", worktreeId: "fix-login" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "new", worktreeId: "fix-login" },
		});
		// Plain new stays exactly as before (no worktreeId key).
		const plain = parseHello({ conversation: { target: "new" } });
		expect(plain).toMatchObject({ mode: "conversation", conversation: { target: "new" } });
		if (plain.mode === "conversation") {
			expect(plain.conversation).not.toHaveProperty("worktreeId");
		}
	});

	test("rejects worktreeId on last/session targets (resume derives from the binding)", () => {
		expect(() => parseHello({ conversation: { target: "last", worktreeId: "fix-login" } })).toThrow(
			"must not include worktreeId",
		);
		expect(() =>
			parseHello({ conversation: { target: "session", sessionId: "abc123", worktreeId: "fix-login" } }),
		).toThrow("must not include worktreeId");
	});

	test("pattern-validates worktreeId and keeps the field allowlist strict", () => {
		for (const invalid of ["UPPER", "-leading", "a/b", "../evil", "", "a".repeat(65), 42, null, true]) {
			expect(() => parseHello({ conversation: { target: "new", worktreeId: invalid } })).toThrow();
		}
		expect(() => parseHello({ conversation: { target: "new", worktreeId: "fix-login", extra: true } })).toThrow();
	});

	test("accepts workingDirectory only on target new and validates relative POSIX paths", () => {
		expect(parseHello({ conversation: { target: "new", workingDirectory: "packages/app" } })).toMatchObject({
			mode: "conversation",
			conversation: { target: "new", workingDirectory: "packages/app" },
		});
		for (const invalid of [
			"",
			".",
			"../app",
			"/tmp",
			"packages/../app",
			"packages//app",
			"packages/.git",
			"packages/.Git",
			"packages/\tapp",
			"C:/repo",
			42,
		]) {
			expect(() => parseHello({ conversation: { target: "new", workingDirectory: invalid } })).toThrow();
		}
		expect(() => parseHello({ conversation: { target: "last", workingDirectory: "packages/app" } })).toThrow(
			"must not include workingDirectory",
		);
	});

	test("accepts the manage_worktrees management purpose and rejects unknown purposes", () => {
		expect(parseHello({ workspaceManagement: { purpose: "manage_worktrees" } })).toMatchObject({
			mode: "workspaceManagement",
			workspaceManagement: { purpose: "manage_worktrees" },
		});
		expect(parseHello({ workspaceManagement: { purpose: "unregister_workspace" } })).toMatchObject({
			workspaceManagement: { purpose: "unregister_workspace" },
		});
		expect(parseHello({ workspaceManagement: { purpose: "manage_agents" } })).toMatchObject({
			workspaceManagement: { purpose: "manage_agents" },
		});
		expect(() => parseHello({ workspaceManagement: { purpose: "manage_everything" } })).toThrow();
	});
});

describe("handshake response: worktreeId echo", () => {
	test("round-trips worktreeId and workingDirectory in conversation metadata", () => {
		const parsed = parseIrohRemoteHandshakeResponseLine(
			responseLine({
				sessionId: "abc123",
				conversation: {
					target: "new",
					sessionId: "abc123",
					selection: "created",
					worktreeId: "fix-login",
					workingDirectory: "packages/app",
				},
			}),
		);
		expect(parsed).toMatchObject({
			success: true,
			conversation: {
				target: "new",
				sessionId: "abc123",
				selection: "created",
				worktreeId: "fix-login",
				workingDirectory: "packages/app",
			},
		});
	});

	test("rejects invalid response worktreeIds and unknown metadata fields", () => {
		expect(() =>
			parseIrohRemoteHandshakeResponseLine(
				responseLine({
					sessionId: "abc123",
					conversation: { target: "new", sessionId: "abc123", selection: "created", worktreeId: "UPPER" },
				}),
			),
		).toThrow("must match lowercase worktree id syntax");
		expect(() =>
			parseIrohRemoteHandshakeResponseLine(
				responseLine({
					sessionId: "abc123",
					conversation: { target: "new", sessionId: "abc123", selection: "created", bogus: true },
				}),
			),
		).toThrow();
	});

	test("manage_worktrees round-trips as a workspaceManagement response purpose", () => {
		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceManagement: { purpose: "manage_worktrees" } })),
		).toMatchObject({ success: true, workspaceManagement: { purpose: "manage_worktrees" } });
		expect(
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceManagement: { purpose: "manage_agents" } })),
		).toMatchObject({ success: true, workspaceManagement: { purpose: "manage_agents" } });
		expect(() =>
			parseIrohRemoteHandshakeResponseLine(responseLine({ workspaceManagement: { purpose: "bogus" } })),
		).toThrow();
	});

	test("createIrohRemoteHandshakeSuccess emits a parseable worktree-bound response", () => {
		const success = createIrohRemoteHandshakeSuccess({
			workspace: "volt",
			hostNodeId: "host-node",
			clientNodeId: "client-node",
			features: [...IROH_REMOTE_HOST_FEATURES],
			sessionId: "abc123",
			conversation: {
				target: "new",
				sessionId: "abc123",
				selection: "created",
				worktreeId: "fix-login",
				workingDirectory: "packages/app",
			},
		});
		const parsed = parseIrohRemoteHandshakeResponseLine(JSON.stringify(success));
		expect(parsed).toMatchObject({
			success: true,
			conversation: {
				target: "new",
				sessionId: "abc123",
				selection: "created",
				worktreeId: "fix-login",
				workingDirectory: "packages/app",
			},
		});
	});
});

describe("integrated conversation handshake response echo", () => {
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["volt"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "volt", path: "/tmp/volt" },
		workspaceNames: ["volt"],
		workspaces: [{ name: "volt", status: "available" }],
	};
	const hello = {
		type: "volt_iroh_hello",
		protocol: IROH_REMOTE_ALPN,
		workspace: "volt",
		mode: "conversation",
		conversation: { target: "new", worktreeId: "fix-login" },
	} as IrohRemoteHello;
	const handshakeResponse = {
		child: "volt",
		features: [...IROH_REMOTE_HOST_FEATURES],
	} as unknown as IrohRemoteHandshakeSuccess;

	test("echoes worktreeId and workingDirectory for bound conversations", () => {
		const bound = createIntegratedConversationHandshakeResponse(
			{ hello, response: handshakeResponse },
			authorization,
			"abc123",
			{ kind: "created", sessionId: "abc123" },
			{},
			"fix-login",
			"packages/app",
		);
		expect(bound.conversation).toMatchObject({
			target: "new",
			sessionId: "abc123",
			selection: "created",
			worktreeId: "fix-login",
			workingDirectory: "packages/app",
		});

		const unbound = createIntegratedConversationHandshakeResponse(
			{ hello, response: handshakeResponse },
			authorization,
			"abc123",
			{ kind: "created", sessionId: "abc123" },
			{},
		);
		expect(unbound.conversation).not.toHaveProperty("worktreeId");
	});
});
