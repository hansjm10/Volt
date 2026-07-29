import { describe, expect, it } from "vitest";
import {
	authorizeToolOperation,
	getTrustedToolOperationResolver,
	type IntegrationReadAuthority,
	isToolVisibleUnderGrant,
	operationProvidesResearchEvidence,
	RESEARCH_OPERATION_GRANT_PROFILE,
	resolverCanProvideResearchEvidence,
} from "../src/core/operation-authorization.ts";

function createIntegrationAuthority(): IntegrationReadAuthority {
	return {
		hasTrustedReads: (serverId) => serverId === "trusted",
		hasTrustedToolReads: (serverId) => serverId === "trusted",
		hasTrustedResourceReads: (serverId) => serverId === "trusted",
		isTrustedToolRead: (serverId, toolName) => serverId === "trusted" && toolName === "read_issue",
	};
}

describe("operation authorization", () => {
	it("composes a reusable research grant without mode-specific tool metadata", () => {
		const read = getTrustedToolOperationResolver("read");
		const write = getTrustedToolOperationResolver("write");
		const bash = getTrustedToolOperationResolver("bash");
		const inspect = getTrustedToolOperationResolver("inspect");
		const updatePlan = getTrustedToolOperationResolver("update_plan");
		const updateProgress = getTrustedToolOperationResolver("update_plan_progress");
		expect(isToolVisibleUnderGrant(read, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(true);
		expect(isToolVisibleUnderGrant(write, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);
		expect(isToolVisibleUnderGrant(bash, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);
		expect(isToolVisibleUnderGrant(inspect, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(true);
		expect(isToolVisibleUnderGrant(updatePlan, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(true);
		expect(isToolVisibleUnderGrant(updateProgress, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);
		expect(isToolVisibleUnderGrant(undefined, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);

		expect(resolverCanProvideResearchEvidence(read, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(true);
		expect(resolverCanProvideResearchEvidence(inspect, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(true);
		expect(resolverCanProvideResearchEvidence(updatePlan, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);
		expect(resolverCanProvideResearchEvidence(write, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);
		expect(resolverCanProvideResearchEvidence(undefined, RESEARCH_OPERATION_GRANT_PROFILE)).toBe(false);

		const readDecision = authorizeToolOperation(read, { path: "README.md" }, RESEARCH_OPERATION_GRANT_PROFILE);
		expect(readDecision).toMatchObject({
			allowed: true,
			resolution: { kind: "resolved", capabilities: ["workspace.read"] },
		});
		expect(operationProvidesResearchEvidence(readDecision.resolution)).toBe(true);
		expect(authorizeToolOperation(write, { path: "README.md" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			missingCapabilities: ["workspace.write"],
		});
		expect(authorizeToolOperation(bash, { command: "git status" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			missingCapabilities: ["process.execute"],
		});
		expect(authorizeToolOperation(updatePlan, {}, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: true,
			resolution: { capabilities: ["session.plan"] },
		});
		expect(authorizeToolOperation(updateProgress, {}, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			missingCapabilities: ["session.execution"],
		});
		expect(
			authorizeToolOperation(
				getTrustedToolOperationResolver("custom_extension_operation"),
				{},
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({
			allowed: false,
			resolution: { kind: "unknown" },
		});
	});

	it("resolves parameter-sensitive LSP and inspection operations", () => {
		const lsp = getTrustedToolOperationResolver("lsp");
		expect(authorizeToolOperation(lsp, { action: "diagnostics" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: true,
		});
		expect(authorizeToolOperation(lsp, { action: "rename" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			missingCapabilities: ["workspace.write"],
		});
		expect(authorizeToolOperation(lsp, { action: "future-action" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			resolution: { kind: "unknown" },
		});

		const inspect = getTrustedToolOperationResolver("inspect");
		expect(
			authorizeToolOperation(inspect, { operation: "git.log", args: ["-n", "5"] }, RESEARCH_OPERATION_GRANT_PROFILE),
		).toMatchObject({
			allowed: true,
			resolution: { capabilities: ["workspace.read", "process.inspect"] },
		});
		expect(
			authorizeToolOperation(
				inspect,
				{ operation: "gh.issue.view", args: ["123"] },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({
			allowed: true,
			resolution: { capabilities: ["network.read", "process.inspect"] },
		});
		expect(
			authorizeToolOperation(
				inspect,
				{ operation: "git.diff", args: ["--output=stolen.patch"] },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({ allowed: false, resolution: { kind: "unknown" } });
	});

	it("maps every MCP gateway action and requires host trust evidence for reads", () => {
		const mcp = getTrustedToolOperationResolver("mcp", { integrationReadAuthority: createIntegrationAuthority() });
		for (const action of ["status", "list_servers", "search"]) {
			expect(authorizeToolOperation(mcp, { action }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
				allowed: true,
				resolution: { capabilities: ["integration.discover"] },
			});
		}
		const readCache = authorizeToolOperation(mcp, { action: "read_cache" }, RESEARCH_OPERATION_GRANT_PROFILE);
		expect(readCache).toMatchObject({
			allowed: true,
			resolution: { capabilities: ["integration.discover"] },
		});
		expect(operationProvidesResearchEvidence(readCache.resolution)).toBe(false);
		for (const action of ["connect", "describe", "list_tools"]) {
			expect(
				authorizeToolOperation(mcp, { action, server: "trusted" }, RESEARCH_OPERATION_GRANT_PROFILE),
			).toMatchObject({ allowed: true });
			expect(
				authorizeToolOperation(mcp, { action, server: "other" }, RESEARCH_OPERATION_GRANT_PROFILE),
			).toMatchObject({ allowed: false, resolution: { kind: "unknown" } });
		}
		const resourcesOnly = getTrustedToolOperationResolver("mcp", {
			integrationReadAuthority: {
				hasTrustedReads: (serverId) => serverId === "resources",
				hasTrustedToolReads: () => false,
				hasTrustedResourceReads: (serverId) => serverId === "resources",
				isTrustedToolRead: () => false,
			},
		});
		expect(
			authorizeToolOperation(
				resourcesOnly,
				{ action: "connect", server: "resources" },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({ allowed: true });
		expect(
			authorizeToolOperation(
				resourcesOnly,
				{ action: "list_tools", server: "resources" },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({ allowed: false, resolution: { kind: "unknown" } });

		for (const action of ["list_resources", "read_resource"]) {
			expect(
				authorizeToolOperation(mcp, { action, server: "trusted" }, RESEARCH_OPERATION_GRANT_PROFILE),
			).toMatchObject({ allowed: true });
			expect(
				authorizeToolOperation(mcp, { action, server: "other" }, RESEARCH_OPERATION_GRANT_PROFILE),
			).toMatchObject({ allowed: false });
		}
		expect(
			authorizeToolOperation(
				mcp,
				{ action: "call", server: "trusted", tool: "read_issue" },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({ allowed: true });
		expect(
			authorizeToolOperation(
				mcp,
				{ action: "call", server: "trusted", tool: "update_issue" },
				RESEARCH_OPERATION_GRANT_PROFILE,
			),
		).toMatchObject({ allowed: false, resolution: { kind: "unknown" } });

		for (const action of [
			"disconnect",
			"set_enabled",
			"auth",
			"poll_auth",
			"cancel_auth",
			"logout",
			"list_prompts",
			"get_prompt",
		]) {
			expect(
				authorizeToolOperation(mcp, { action, server: "trusted" }, RESEARCH_OPERATION_GRANT_PROFILE),
			).toMatchObject({ allowed: false });
		}
		expect(authorizeToolOperation(mcp, { action: "future" }, RESEARCH_OPERATION_GRANT_PROFILE)).toMatchObject({
			allowed: false,
			resolution: { kind: "unknown" },
		});
	});
});
