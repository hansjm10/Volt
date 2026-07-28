import { expect, test } from "vitest";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { projectSessionTranscript } from "../../../src/core/rpc/transcript.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	createRemoteConversationTranscriptEntry,
	createRemoteConversationTranscriptPage,
	handleIntegratedConversationRpcCommand,
} from "../../../src/daemon/conversation-commands.ts";
import { createHarness } from "../harness.ts";

function createAuthorization(workspacePath: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

test("remote transcripts surface subagent recovery notices as system text", async () => {
	const harness = await createHarness();
	try {
		const noticeText = `Recovered result at ${harness.tempDir}/report.md`;
		const recoveryEntryId = harness.sessionManager.appendCustomMessageEntry("subagent_recovery", noticeText, true);
		const recoveryEntry = harness.sessionManager
			.getBranch()
			.find((entry): entry is SessionEntry => entry.id === recoveryEntryId);
		if (recoveryEntry === undefined) {
			throw new Error("Expected persisted subagent recovery notice");
		}

		const runtime: ConversationCommandRuntime = {
			session: {
				sessionId: harness.session.sessionId,
				sessionManager: harness.sessionManager,
			},
			listSessions: async () => [],
		};
		const authorization = createAuthorization(harness.tempDir);
		expect(createRemoteConversationTranscriptEntry(recoveryEntry, authorization, runtime)).toMatchObject({
			entryId: recoveryEntryId,
			role: "system",
			text: "Recovered result at /workspace/report.md",
		});

		const reviewEntryId = harness.sessionManager.appendCustomMessageEntry("review", "Review result", true);
		const hiddenRecoveryEntryId = harness.sessionManager.appendCustomMessageEntry(
			"subagent_recovery",
			"Hidden recovery",
			false,
		);
		const extensionEntryId = harness.sessionManager.appendCustomMessageEntry(
			"extension.note",
			"Displayed extension note",
			true,
		);

		const localTranscript = projectSessionTranscript(harness.sessionManager);
		expect(localTranscript.items).toEqual([
			expect.objectContaining({ id: recoveryEntryId, role: "system", text: noticeText }),
			expect.objectContaining({ id: reviewEntryId, role: "assistant", text: "Review result" }),
		]);

		const remotePage = createRemoteConversationTranscriptPage(authorization, runtime);
		expect(remotePage?.items).toEqual([
			expect.objectContaining({
				entryId: recoveryEntryId,
				role: "system",
				text: "Recovered result at /workspace/report.md",
			}),
			expect.objectContaining({ entryId: reviewEntryId, role: "assistant", text: "Review result" }),
		]);
		expect(remotePage?.items.map((item) => item.entryId)).not.toContain(hiddenRecoveryEntryId);
		expect(remotePage?.items.map((item) => item.entryId)).not.toContain(extensionEntryId);

		const context: ConversationCommandContext = {
			stateManager: new IrohRemoteHostStateManager(),
			sessionListCursors: new Map(),
			sessionListCursorTtlMs: 60_000,
		};
		const continuation = (await handleIntegratedConversationRpcCommand(
			{ id: "recovery-text", type: "get_transcript_entry_text", entryId: recoveryEntryId },
			authorization,
			context,
			runtime,
		)) as Record<string, unknown>;
		expect(continuation).toMatchObject({
			id: "recovery-text",
			command: "get_transcript_entry_text",
			success: true,
			data: {
				entryId: recoveryEntryId,
				text: "Recovered result at /workspace/report.md",
				truncated: false,
				nextOffset: null,
			},
		});
	} finally {
		harness.cleanup();
	}
});
