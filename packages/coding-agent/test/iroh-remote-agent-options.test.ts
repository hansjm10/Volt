import { describe, expect, test } from "vitest";
import { getIrohRemoteRpcCommandCapabilities } from "../src/core/remote/iroh/access-grant.ts";
import {
	handleIrohRemoteAgentOptionsRpcCommand,
	type IrohRemoteAgentOptionsRpcBackend,
} from "../src/core/remote/iroh/agent-options.ts";

function backend(): IrohRemoteAgentOptionsRpcBackend {
	return {
		getAgentOptions: async (workspaceName) => ({
			workspaceName,
			models: [],
			defaultConfig: {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		}),
	};
}

describe("agent_options.v1 RPC", () => {
	test("strictly parses discovery and binds it to the authorized workspace", async () => {
		await expect(
			handleIrohRemoteAgentOptionsRpcCommand(
				{ id: "request-1", type: "get_agent_options", workspaceName: "volt" },
				{ authorizedWorkspaceName: "volt", backend: backend() },
			),
		).resolves.toMatchObject({
			handled: true,
			response: {
				id: "request-1",
				success: true,
				data: { workspaceName: "volt", defaultConfig: { agentMode: "build" } },
			},
		});

		for (const command of [
			{ type: "get_agent_options", workspaceName: "volt", extra: true },
			{ id: 123, type: "get_agent_options", workspaceName: "volt" },
		]) {
			await expect(
				handleIrohRemoteAgentOptionsRpcCommand(command, {
					authorizedWorkspaceName: "volt",
					backend: backend(),
				}),
			).resolves.toMatchObject({ handled: true, response: { success: false, error: "invalid_request" } });
		}

		await expect(
			handleIrohRemoteAgentOptionsRpcCommand(
				{ type: "get_agent_options", workspaceName: "other" },
				{ authorizedWorkspaceName: "volt", backend: backend() },
			),
		).resolves.toMatchObject({ handled: true, response: { success: false, error: "session_mismatch" } });
	});

	test("contains backend failures as ordinary correlated RPC failures", async () => {
		await expect(
			handleIrohRemoteAgentOptionsRpcCommand(
				{ id: "request-1", type: "get_agent_options", workspaceName: "volt" },
				{
					authorizedWorkspaceName: "volt",
					backend: { getAgentOptions: async () => Promise.reject(new Error("failed")) },
				},
			),
		).resolves.toEqual({
			handled: true,
			response: {
				id: "request-1",
				type: "response",
				command: "get_agent_options",
				success: false,
				error: "request_failed",
			},
		});
	});

	test("requires model selection authority", () => {
		expect(getIrohRemoteRpcCommandCapabilities({ type: "get_agent_options" } as never)).toEqual(["model.select.v1"]);
	});
});
