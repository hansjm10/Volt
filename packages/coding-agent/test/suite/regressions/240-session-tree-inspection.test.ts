import { join } from "node:path";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { expect, test } from "vitest";
import {
	createIrohRemotePresetAccess,
	getIrohRemoteRpcCommandCapabilities,
} from "../../../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { getStaticIrohRemoteRpcFilterResult } from "../../../src/core/remote/iroh/rpc-command-filter.ts";
import { IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS } from "../../../src/core/remote/iroh/transcript-text.ts";
import { projectSessionTreePage } from "../../../src/core/rpc/session-tree.ts";
import { projectConversationTranscriptItems } from "../../../src/core/rpc/transcript.ts";
import type { RpcSessionTreePage } from "../../../src/core/rpc/types.ts";
import {
	type ConversationCommandRuntime,
	createRemoteGetMessageImagesRpcResponse,
	createRemoteGetSessionTreeRpcResponse,
	createRemoteGetTranscriptEntryTextRpcResponse,
} from "../../../src/daemon/conversation-commands.ts";
import { createHarness } from "../harness.ts";

function createAuthorization(workspacePath: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "phone-node",
			label: "phone",
			allowedWorkspaces: ["workspace"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "workspace", path: workspacePath },
		workspaceNames: ["workspace"],
		workspaces: [{ name: "workspace", status: "available" }],
	};
}

function getSuccessfulTree(response: object): RpcSessionTreePage {
	const value = response as { success?: boolean; data?: RpcSessionTreePage };
	if (value.success !== true || value.data === undefined) {
		throw new Error(`Expected successful session tree response: ${JSON.stringify(response)}`);
	}
	return value.data;
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

test("get_session_tree pages sanitized branch topology without raw session entries", async () => {
	const harness = await createHarness();
	try {
		const rootId = harness.sessionManager.appendMessage({
			role: "user",
			content: `inspect ${join(harness.tempDir, "secret.txt")}`,
			timestamp: 1,
		});
		const inactiveId = harness.sessionManager.appendMessage(assistantMessage("old branch", 2));
		harness.sessionManager.branch(rootId);
		const structuralId = harness.sessionManager.appendCustomEntry("provider-private", {
			providerPayload: "must-not-cross-wire",
		});
		const activeId = harness.sessionManager.appendMessage(assistantMessage("active branch", 3));

		const runtime: ConversationCommandRuntime = {
			session: {
				sessionId: harness.sessionManager.getSessionId(),
				sessionManager: harness.sessionManager,
			},
			listSessions: async () => [],
		};
		const authorization = createAuthorization(harness.tempDir);
		const first = getSuccessfulTree(
			createRemoteGetSessionTreeRpcResponse(
				{ id: "tree-1", type: "get_session_tree", limit: 2 },
				authorization,
				runtime,
			),
		);
		expect(first.nodes).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(first.nextAfterOrdinal).toBe(first.nodes.at(-1)?.ordinal);

		const second = getSuccessfulTree(
			createRemoteGetSessionTreeRpcResponse(
				{
					id: "tree-2",
					type: "get_session_tree",
					afterOrdinal: first.nextAfterOrdinal,
				},
				authorization,
				runtime,
			),
		);
		const nodes = [...first.nodes, ...second.nodes];
		expect(nodes.map((node) => node.entryId)).toEqual(harness.sessionManager.getEntries().map((entry) => entry.id));
		expect(nodes.find((node) => node.entryId === inactiveId)?.activeBranch).toBe(false);
		expect(nodes.find((node) => node.entryId === structuralId)).toMatchObject({
			parentEntryId: rootId,
			activeBranch: true,
			transcript: null,
		});
		expect(nodes.find((node) => node.entryId === activeId)?.parentEntryId).toBe(structuralId);
		expect(JSON.stringify({ first, second })).not.toContain("must-not-cross-wire");
		expect(JSON.stringify({ first, second })).not.toContain(harness.tempDir);
		expect(JSON.stringify({ first, second })).toContain("/workspace/secret.txt");

		const entries = harness.sessionManager.getEntries();
		const localTranscript = new Map(projectConversationTranscriptItems(entries).map((item) => [item.entryId, item]));
		const local = projectSessionTreePage(entries, harness.sessionManager.getBranch(), {
			sessionId: harness.sessionManager.getSessionId(),
			limit: 2,
			projectTranscriptEntry: (entry) => localTranscript.get(entry.id),
		});
		expect(Object.keys(local).sort()).toEqual(
			Object.keys(first)
				.filter((key) => key !== "workspaceName")
				.sort(),
		);
		expect(Object.keys(local.nodes[0]!).sort()).toEqual(Object.keys(first.nodes[0]!).sort());
	} finally {
		harness.cleanup();
	}
});

test("inactive tree-node continuation metadata remains recoverable", async () => {
	const harness = await createHarness();
	try {
		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const longText = `${"x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS)}END`;
		const inactiveId = harness.sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: longText },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp: 2,
		});
		harness.sessionManager.branch(rootId);
		harness.sessionManager.appendMessage(assistantMessage("active branch", 3));

		const runtime: ConversationCommandRuntime = {
			session: {
				sessionId: harness.sessionManager.getSessionId(),
				sessionManager: harness.sessionManager,
			},
			listSessions: async () => [],
		};
		const authorization = createAuthorization(harness.tempDir);
		const tree = getSuccessfulTree(
			createRemoteGetSessionTreeRpcResponse({ id: "tree", type: "get_session_tree" }, authorization, runtime),
		);
		expect(tree.nodes.find((node) => node.entryId === inactiveId)).toMatchObject({
			activeBranch: false,
			transcript: { entryId: inactiveId, truncated: true, imageCount: 1 },
		});

		const firstText = createRemoteGetTranscriptEntryTextRpcResponse(
			{ id: "text-1", type: "get_transcript_entry_text", entryId: inactiveId },
			authorization,
			runtime,
		) as {
			success: boolean;
			data: { entryId: string; text: string; truncated: boolean; nextOffset: number | null };
		};
		expect(firstText.success).toBe(true);
		expect(firstText.data).toMatchObject({
			entryId: inactiveId,
			text: "x".repeat(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS),
			truncated: true,
			nextOffset: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
		});
		const remainingText = createRemoteGetTranscriptEntryTextRpcResponse(
			{
				id: "text-2",
				type: "get_transcript_entry_text",
				entryId: inactiveId,
				offset: firstText.data.nextOffset,
			},
			authorization,
			runtime,
		) as { success: boolean; data: { text: string; truncated: boolean; nextOffset: number | null } };
		expect(remainingText).toMatchObject({
			success: true,
			data: { text: "END", truncated: false, nextOffset: null },
		});

		const images = createRemoteGetMessageImagesRpcResponse(
			{ id: "images", type: "get_message_images", entryId: inactiveId },
			authorization,
			runtime,
		);
		expect(images).toMatchObject({
			success: true,
			data: {
				entryId: inactiveId,
				totalImages: 1,
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", index: 0 }],
				nextImageIndex: null,
			},
		});
	} finally {
		harness.cleanup();
	}
});

test("get_session_tree is an observe-capability remote command", () => {
	expect(getStaticIrohRemoteRpcFilterResult(JSON.stringify({ id: "tree", type: "get_session_tree" }))).toEqual({
		allowed: true,
		command: { id: "tree", type: "get_session_tree" },
	});
	expect(getIrohRemoteRpcCommandCapabilities({ type: "get_session_tree" })).toEqual(["conversation.observe.v1"]);
});
