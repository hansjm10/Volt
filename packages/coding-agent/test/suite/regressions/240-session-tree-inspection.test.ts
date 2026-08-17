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
import type {
	RpcCommand,
	RpcMessageImagesResponse,
	RpcResponse,
	RpcSessionTreePage,
} from "../../../src/core/rpc/types.ts";
import {
	type ConversationCommandRuntime,
	createRemoteGetMessageImagesRpcResponse,
	createRemoteGetSessionTreeRpcResponse,
	createRemoteGetTranscriptEntryTextRpcResponse,
} from "../../../src/daemon/conversation-commands.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../../src/modes/rpc/rpc-command-dispatcher.ts";
import { createHarness, type Harness } from "../harness.ts";

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

function getSuccessfulImages(response: object): RpcMessageImagesResponse {
	const value = response as { success?: boolean; data?: RpcMessageImagesResponse };
	if (value.success !== true || value.data === undefined) {
		throw new Error(`Expected successful message images response: ${JSON.stringify(response)}`);
	}
	return value.data;
}

async function dispatchLocalRpcCommand(command: RpcCommand, harness: Harness): Promise<RpcResponse> {
	const response = await handleRpcCommand(command, {
		session: harness.session,
	} as unknown as RpcCommandDispatcherContext);
	if (response === undefined) {
		throw new Error(`Expected immediate local RPC response for ${command.type}`);
	}
	return response;
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

test("session tree resolves reused tool-call ids within each branch", async () => {
	const harness = await createHarness();
	try {
		const toolCallId = "call_1";
		const appendReadCall = (path: string, timestamp: number): string =>
			harness.sessionManager.appendMessage({
				...assistantMessage("", timestamp),
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
				stopReason: "toolUse",
			});
		const appendReadResult = (timestamp: number): string =>
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp,
			});

		const rootId = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		appendReadCall("branch-a.txt", 2);
		const branchAResultId = appendReadResult(3);
		appendReadCall("branch-a-later.txt", 4);
		const branchALaterResultId = appendReadResult(5);
		harness.sessionManager.branch(rootId);
		appendReadCall("branch-b.txt", 6);
		const branchBResultId = appendReadResult(7);

		const runtime: ConversationCommandRuntime = {
			session: {
				sessionId: harness.sessionManager.getSessionId(),
				sessionManager: harness.sessionManager,
			},
			listSessions: async () => [],
		};
		const remote = getSuccessfulTree(
			createRemoteGetSessionTreeRpcResponse(
				{ id: "remote-tree", type: "get_session_tree" },
				createAuthorization(harness.tempDir),
				runtime,
			),
		);
		const local = getSuccessfulTree(
			await dispatchLocalRpcCommand({ id: "local-tree", type: "get_session_tree" }, harness),
		);

		for (const tree of [remote, local]) {
			expect(tree.nodes.find((node) => node.entryId === branchAResultId)).toMatchObject({
				activeBranch: false,
				transcript: {
					path: "branch-a.txt",
					args: { path: "branch-a.txt" },
					summary: "Read branch-a.txt (completed)",
				},
			});
			expect(tree.nodes.find((node) => node.entryId === branchALaterResultId)).toMatchObject({
				activeBranch: false,
				transcript: {
					path: "branch-a-later.txt",
					args: { path: "branch-a-later.txt" },
					summary: "Read branch-a-later.txt (completed)",
				},
			});
			expect(tree.nodes.find((node) => node.entryId === branchBResultId)).toMatchObject({
				activeBranch: true,
				transcript: {
					path: "branch-b.txt",
					args: { path: "branch-b.txt" },
					summary: "Read branch-b.txt (completed)",
				},
			});
		}
	} finally {
		harness.cleanup();
	}
});

test("local session tree tracks truncation without parsing projected text", async () => {
	const harness = await createHarness();
	try {
		const literalSuffix = "complete\n[truncated]";
		const literalUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: literalSuffix,
			timestamp: 1,
		});
		const literalAssistantId = harness.sessionManager.appendMessage(assistantMessage(literalSuffix, 2));
		const longUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: "x".repeat(16_001),
			timestamp: 3,
		});
		const toolCallId = "long-summary";
		harness.sessionManager.appendMessage({
			...assistantMessage("", 4),
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "read",
					arguments: { path: "p".repeat(1_200) },
				},
			],
			stopReason: "toolUse",
		});
		const longToolSummaryId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 5,
		});

		const tree = getSuccessfulTree(
			await dispatchLocalRpcCommand({ id: "local-tree", type: "get_session_tree" }, harness),
		);
		const transcripts = new Map(tree.nodes.map((node) => [node.entryId, node.transcript]));

		expect(transcripts.get(literalUserId)).toMatchObject({ text: literalSuffix, truncated: false });
		expect(transcripts.get(literalAssistantId)).toMatchObject({ text: literalSuffix, truncated: false });
		expect(transcripts.get(longUserId)).toMatchObject({ truncated: true });
		expect(transcripts.get(longUserId)?.text.endsWith("\n[truncated]")).toBe(true);
		expect(transcripts.get(longToolSummaryId)).toMatchObject({ role: "tool", truncated: true });
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
		const inactiveToolCallId = "inactive-image-call";
		harness.sessionManager.appendMessage({
			...assistantMessage("", 3),
			content: [
				{
					type: "toolCall",
					id: inactiveToolCallId,
					name: "read",
					arguments: { path: "inactive.png" },
				},
			],
		});
		const inactiveToolId = harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: inactiveToolCallId,
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 4,
		});
		harness.sessionManager.branch(rootId);
		const activeImageId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", data: "YWN0aXZl", mimeType: "image/jpeg" }],
			timestamp: 5,
		});
		harness.sessionManager.appendMessage(assistantMessage("active branch", 6));

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

		const expectedImages = new Map([
			[inactiveId, { data: "aW1hZ2U=", mimeType: "image/png", activeBranch: false }],
			[inactiveToolId, { data: "dG9vbA==", mimeType: "image/png", activeBranch: false }],
			[activeImageId, { data: "YWN0aXZl", mimeType: "image/jpeg", activeBranch: true }],
		]);
		expect(
			tree.nodes.flatMap((node) => {
				const imageCount = node.transcript?.imageCount;
				return imageCount === undefined
					? []
					: [{ entryId: node.entryId, imageCount, activeBranch: node.activeBranch }];
			}),
		).toEqual(
			[...expectedImages].map(([entryId, image]) => ({
				entryId,
				imageCount: 1,
				activeBranch: image.activeBranch,
			})),
		);

		for (const [entryId, image] of expectedImages) {
			expect(
				getSuccessfulImages(
					createRemoteGetMessageImagesRpcResponse(
						{ id: `remote-images-${entryId}`, type: "get_message_images", entryId },
						authorization,
						runtime,
					),
				),
			).toMatchObject({
				entryId,
				totalImages: 1,
				images: [{ type: "image", data: image.data, mimeType: image.mimeType, index: 0 }],
				nextImageIndex: null,
			});
		}

		const localTree = getSuccessfulTree(
			await dispatchLocalRpcCommand({ id: "local-tree", type: "get_session_tree" }, harness),
		);
		expect(
			localTree.nodes.flatMap((node) => {
				const imageCount = node.transcript?.imageCount;
				return imageCount === undefined
					? []
					: [{ entryId: node.entryId, imageCount, activeBranch: node.activeBranch }];
			}),
		).toEqual(
			[...expectedImages].map(([entryId, image]) => ({
				entryId,
				imageCount: 1,
				activeBranch: image.activeBranch,
			})),
		);
		for (const [entryId, image] of expectedImages) {
			expect(
				getSuccessfulImages(
					await dispatchLocalRpcCommand(
						{ id: `local-images-${entryId}`, type: "get_message_images", entryId },
						harness,
					),
				),
			).toMatchObject({
				entryId,
				totalImages: 1,
				images: [{ type: "image", data: image.data, mimeType: image.mimeType, index: 0 }],
				nextImageIndex: null,
			});
		}
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
