import { describe, expect, test } from "vitest";
import { getIrohRemoteRpcCommandCapabilities } from "../src/core/remote/iroh/access-grant.ts";
import {
	createIrohRemoteAgentLaunchSessionId,
	digestIrohRemoteAgentLaunchRequest,
	handleIrohRemoteAgentLaunchRpcCommand,
	type IrohRemoteAgentLaunchRpcBackend,
	type IrohRemoteCreateAgentRequest,
} from "../src/core/remote/iroh/agent-launch.ts";

const request: IrohRemoteCreateAgentRequest = {
	launchId: "launch-1",
	catalogRevision: "revision-1",
	placement: { kind: "workspace" },
	config: { fastModeEnabled: false, agentMode: "build" },
};

function backend(): IrohRemoteAgentLaunchRpcBackend {
	return {
		getAgentLaunchOptions: async (workspaceName) => ({
			workspaceName,
			revision: "revision-1",
			models: [],
			defaultConfig: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		}),
		createAgent: async (_workspaceName, input) => ({
			kind: "created",
			launchId: input.launchId,
			sessionId: "agent-session",
			placement: { kind: "workspace" },
			config: {
				kind: "configured",
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		}),
	};
}

describe("agent_launch.v1 RPC", () => {
	test("strictly parses create_agent and binds it to the authorized workspace", async () => {
		const result = await handleIrohRemoteAgentLaunchRpcCommand(
			{
				id: "request-1",
				type: "create_agent",
				conversationAuthority: {
					sessionId: "session-1",
					subscriptionId: "subscription-1",
					branchEpoch: "branch-1",
				},
				workspaceName: "volt",
				...request,
			},
			{ authorizedWorkspaceName: "volt", backend: backend() },
		);
		expect(result).toMatchObject({
			handled: true,
			response: {
				id: "request-1",
				success: true,
				data: { kind: "created", launchId: "launch-1", sessionId: "agent-session" },
			},
		});

		const extra = await handleIrohRemoteAgentLaunchRpcCommand(
			{ type: "create_agent", workspaceName: "volt", ...request, extra: true },
			{ authorizedWorkspaceName: "volt", backend: backend() },
		);
		expect(extra).toMatchObject({ handled: true, response: { success: false, error: "invalid_request" } });

		const nonStringId = await handleIrohRemoteAgentLaunchRpcCommand(
			{ id: 123, type: "create_agent", workspaceName: "volt", ...request },
			{ authorizedWorkspaceName: "volt", backend: backend() },
		);
		expect(nonStringId).toEqual({
			handled: true,
			response: { type: "response", command: "create_agent", success: false, error: "invalid_request" },
		});

		const mismatched = await handleIrohRemoteAgentLaunchRpcCommand(
			{ type: "create_agent", workspaceName: "other", ...request },
			{ authorizedWorkspaceName: "volt", backend: backend() },
		);
		expect(mismatched).toMatchObject({ handled: true, response: { success: false, error: "session_mismatch" } });
	});

	test("contains launch backend failures as correlated RPC responses", async () => {
		const failingBackend: IrohRemoteAgentLaunchRpcBackend = {
			getAgentLaunchOptions: async () => {
				throw new Error("catalog failed");
			},
			createAgent: async () => {
				throw new Error("create failed");
			},
		};
		await expect(
			handleIrohRemoteAgentLaunchRpcCommand(
				{ id: "catalog-request", type: "get_agent_launch_options", workspaceName: "volt" },
				{ authorizedWorkspaceName: "volt", backend: failingBackend },
			),
		).resolves.toEqual({
			handled: true,
			response: {
				id: "catalog-request",
				type: "response",
				command: "get_agent_launch_options",
				success: false,
				error: "agent_launch_catalog_unavailable",
			},
		});
		await expect(
			handleIrohRemoteAgentLaunchRpcCommand(
				{ id: "create-request", type: "create_agent", workspaceName: "volt", ...request },
				{ authorizedWorkspaceName: "volt", backend: failingBackend },
			),
		).resolves.toEqual({
			handled: true,
			response: {
				id: "create-request",
				type: "response",
				command: "create_agent",
				success: false,
				error: "agent_launch_unavailable",
			},
		});
	});

	test("derives stable client/workspace-scoped session ids and request digests", () => {
		const sessionId = createIrohRemoteAgentLaunchSessionId("phone", "volt", request.launchId);
		expect(sessionId).toMatch(/^agent-[a-f0-9]{32}$/);
		expect(createIrohRemoteAgentLaunchSessionId("phone", "volt", request.launchId)).toBe(sessionId);
		expect(createIrohRemoteAgentLaunchSessionId("other-phone", "volt", request.launchId)).not.toBe(sessionId);
		expect(digestIrohRemoteAgentLaunchRequest("volt", request)).toBe(
			digestIrohRemoteAgentLaunchRequest("volt", structuredClone(request)),
		);
		expect(digestIrohRemoteAgentLaunchRequest("other", request)).not.toBe(
			digestIrohRemoteAgentLaunchRequest("volt", request),
		);
	});

	test("uses command-sensitive launch capabilities", () => {
		expect(getIrohRemoteRpcCommandCapabilities({ type: "get_agent_launch_options" } as never)).toEqual([
			"model.select.v1",
		]);
		expect(getIrohRemoteRpcCommandCapabilities({ type: "create_agent", ...request } as never)).toEqual([
			"conversation.control.v1",
		]);
		expect(
			getIrohRemoteRpcCommandCapabilities({
				type: "create_agent",
				...request,
				config: { ...request.config, fastModeEnabled: true },
			} as never),
		).toEqual(["conversation.control.v1", "model.select.v1"]);
		expect(
			getIrohRemoteRpcCommandCapabilities({
				type: "create_agent",
				...request,
				placement: { kind: "new_worktree" },
				config: {
					model: { provider: "test", modelId: "model" },
					thinkingLevel: "high",
					fastModeEnabled: true,
					agentMode: "plan",
				},
			} as never),
		).toEqual(["conversation.control.v1", "model.select.v1", "worktrees.manage.v1"]);
	});
});
