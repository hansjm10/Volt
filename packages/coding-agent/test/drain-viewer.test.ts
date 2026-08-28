/**
 * TUI drain-viewer seams (§6.3): pending acquire enters a read-only overlay
 * that renders viewer events through the real message components, submit is
 * blocked (typed text stays in the editor un-submitted), esc aborts the remote
 * turn, and the warm grant reloads the session and dismisses the overlay.
 */

import { type ActiveToolCallState, type AssistantMessage, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StreamProjector } from "../src/core/rpc/stream-projection.ts";
import { getMarkdownTheme, initTheme } from "../src/core/theme/runtime.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { AcquireOutcome } from "../src/modes/interactive/daemon-attach.ts";
import { DrainViewerComponent } from "../src/modes/interactive/drain-viewer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function assistantUpdate(
	message: AssistantMessage,
	seq: number,
	assistantMessageEvent: Record<string, unknown>,
	toolState: readonly ActiveToolCallState[] = [],
): object {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { ...assistantMessageEvent, seq, snapshot: message, toolState },
	};
}

function sendProjected(viewer: DrainViewerComponent, projector: StreamProjector, event: object): readonly object[] {
	const frames = projector.push(event).frames;
	for (const frame of frames) {
		viewer.handleViewerEvent(frame);
	}
	return frames;
}

function createContext() {
	const context = {
		drainViewer: undefined as DrainViewerComponent | undefined,
		drainViewerFeedId: undefined as string | undefined,
		remoteSessionRefresh: undefined as Promise<void> | undefined,
		ui: { requestRender: vi.fn() },
		chatContainer: { addChild: vi.fn() },
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 40 },
		sessionManager: { getCwd: () => "/tmp" },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		getRegisteredToolDefinition: () => undefined,
		daemonAttach: {
			viewerSubscribe: vi.fn(async () => {}),
			viewerAbort: vi.fn(async () => {}),
			relayCount: () => 0,
		},
		session: { reload: vi.fn(async () => {}), isStreaming: false },
		runtimeHost: {
			refreshCurrentSessionFromDisk: vi.fn(async () => ({ cancelled: false, seeded: false })),
			startRecoveredClientInputs: vi.fn(async () => {}),
		},
		createProjectTrustContext: vi.fn(() => ({})),
		renderCurrentSessionState: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		handleRemoteSessionRefreshFailure: vi.fn(),
		lastQuitWarningAt: 0,
		enterDrainViewer: proto.enterDrainViewer,
		finishDrainViewerGrant: proto.finishDrainViewerGrant,
		handleReacquireOutcome: proto.handleReacquireOutcome,
		absorbRemoteSessionChangesFromDisk: proto.absorbRemoteSessionChangesFromDisk,
		exitDrainViewer: proto.exitDrainViewer,
		isDrainViewerActive: proto.isDrainViewerActive,
		confirmQuitWithAttachedPhone: proto.confirmQuitWithAttachedPhone,
	};
	return context;
}

function deferredGrant() {
	let resolve: (value: { handoff: "cold" | "warm" | "none" }) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<{ handoff: "cold" | "warm" | "none" }>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeAll(() => {
	initTheme();
});

describe("drain viewer (§6.3)", () => {
	it("renders viewer events read-only and takes over warm on grant", async () => {
		const context = createContext();
		const grant = deferredGrant();
		const pending: AcquireOutcome = { kind: "pending", viewerFeedId: "vf-1", granted: grant.promise };

		proto.enterDrainViewer.call(context, pending);
		expect(context.drainViewerFeedId).toBe("vf-1");
		expect(proto.isDrainViewerActive.call(context)).toBe(true);
		expect(context.daemonAttach.viewerSubscribe).toHaveBeenCalledWith("vf-1");
		expect(context.chatContainer.addChild).toHaveBeenCalledTimes(1);

		const viewer = context.drainViewer as DrainViewerComponent;
		expect(viewer).toBeInstanceOf(DrainViewerComponent);

		// Assistant streaming renders through the real message component after
		// reconstructing the projected delta-only viewer wire frame.
		const projector = new StreamProjector();
		const startMessage = fauxAssistantMessage("remote says hi", { timestamp: 0 });
		sendProjected(viewer, projector, { type: "message_start", message: startMessage });
		const updatedMessage = fauxAssistantMessage("remote says hi from the phone", { timestamp: 0 });
		const [wireUpdate] = sendProjected(
			viewer,
			projector,
			assistantUpdate(updatedMessage, 1, {
				type: "text_delta",
				contentIndex: 0,
				delta: " from the phone",
			}),
		);
		expect(wireUpdate).not.toHaveProperty("message");
		sendProjected(viewer, projector, { type: "message_end", message: updatedMessage });
		const rendered = stripAnsi(viewer.render(80).lines.join("\n"));
		expect(rendered).toContain("remote says hi from the phone");
		expect(rendered).toContain("finishing remote turn");

		// Warm grant: keep input fenced until a fresh same-session generation is
		// installed from disk, then re-render and dismiss the overlay.
		let finishRefresh: (value: { cancelled: false; seeded: false }) => void = () => {};
		context.runtimeHost.refreshCurrentSessionFromDisk.mockReturnValue(
			new Promise((resolve) => {
				finishRefresh = resolve;
			}),
		);
		grant.resolve({ handoff: "warm" });
		await vi.waitFor(() => {
			expect(context.runtimeHost.refreshCurrentSessionFromDisk).toHaveBeenCalledTimes(1);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(true);
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();

		finishRefresh({ cancelled: false, seeded: false });
		await vi.waitFor(() => {
			expect(context.renderCurrentSessionState).toHaveBeenCalledTimes(1);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(false);
		expect(context.drainViewerFeedId).toBeUndefined();
	});

	it("refreshes a genuine warm reconnect before recovered input resumes", async () => {
		const context = createContext();
		const phases: string[] = [];
		let finishRefresh: () => void = () => {};
		context.runtimeHost.refreshCurrentSessionFromDisk.mockImplementation(
			() =>
				new Promise((resolve) => {
					phases.push("refresh-start");
					finishRefresh = () => {
						phases.push("refresh-end");
						resolve({ cancelled: false, seeded: false });
					};
				}),
		);
		context.renderCurrentSessionState.mockImplementation(() => phases.push("render"));
		context.runtimeHost.startRecoveredClientInputs.mockImplementation(async () => {
			phases.push("recovery");
		});

		const handling = proto.handleReacquireOutcome.call(context, { kind: "granted", handoff: "warm" });
		await vi.waitFor(() => expect(phases).toEqual(["refresh-start"]));
		expect(context.runtimeHost.startRecoveredClientInputs).not.toHaveBeenCalled();

		finishRefresh();
		await handling;
		expect(phases).toEqual(["refresh-start", "refresh-end", "render", "recovery"]);
	});

	it("reconstructs a mid-message snapshot with subsequent thinking and tool-call deltas", () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-mid", granted: grant.promise });
		const viewer = context.drainViewer as DrainViewerComponent;
		const projector = new StreamProjector();
		const send = (event: object): void => {
			sendProjected(viewer, projector, event);
		};

		let message = fauxAssistantMessage("mid", { timestamp: 0 });
		send(assistantUpdate(message, 1, { type: "text_delta", contentIndex: 0, delta: "mid" }));
		message = fauxAssistantMessage("mid-stream", { timestamp: 0 });
		send(assistantUpdate(message, 2, { type: "text_delta", contentIndex: 0, delta: "-stream" }));

		let richMessage = fauxAssistantMessage(
			[
				{ type: "text", text: "mid-stream" },
				{ type: "thinking", thinking: "" },
			],
			{ timestamp: 0 },
		);
		send(assistantUpdate(richMessage, 3, { type: "thinking_start", contentIndex: 1 }));
		richMessage = fauxAssistantMessage(
			[
				{ type: "text", text: "mid-stream" },
				{ type: "thinking", thinking: "plan" },
			],
			{ timestamp: 0 },
		);
		send(assistantUpdate(richMessage, 4, { type: "thinking_delta", contentIndex: 1, delta: "plan" }));

		const toolStartMessage = fauxAssistantMessage(
			[...richMessage.content, { type: "toolCall", id: "tc-1", name: "write", arguments: {} }],
			{ timestamp: 0 },
		);
		send(
			assistantUpdate(toolStartMessage, 5, { type: "toolcall_start", contentIndex: 2, id: "tc-1", name: "write" }, [
				{ contentIndex: 2, argsText: "" },
			]),
		);
		const argsText = '{"path":"notes.md","content":"done"}';
		const finalMessage = fauxAssistantMessage(
			[
				...richMessage.content,
				{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "notes.md", content: "done" } },
			],
			{ timestamp: 0 },
		);
		send(
			assistantUpdate(finalMessage, 6, { type: "toolcall_delta", contentIndex: 2, argsTextDelta: argsText }, [
				{ contentIndex: 2, argsText },
			]),
		);
		send({ type: "message_end", message: finalMessage });

		const rendered = stripAnsi(viewer.render(100).lines.join("\n"));
		expect(rendered).toContain("mid-stream");
		expect(rendered).toContain("plan");
		expect(rendered).toContain("notes.md");
		grant.reject(new Error("test over"));
	});

	it("keeps tool arguments live when the first observed update is mid-toolcall", () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, {
			kind: "pending",
			viewerFeedId: "vf-mid-tool",
			granted: grant.promise,
		});
		const viewer = context.drainViewer as DrainViewerComponent;
		const projector = new StreamProjector();

		const firstArgsText = '{"path":"no';
		const firstMessage = fauxAssistantMessage(
			{ type: "toolCall", id: "tc-mid", name: "write", arguments: { path: "no" } },
			{ timestamp: 0 },
		);
		sendProjected(
			viewer,
			projector,
			assistantUpdate(firstMessage, 1, { type: "toolcall_delta", contentIndex: 0, argsTextDelta: "no" }, [
				{ contentIndex: 0, argsText: firstArgsText },
			]),
		);
		const argsText = '{"path":"notes.md","content":"done"}';
		const updatedMessage = fauxAssistantMessage(
			{ type: "toolCall", id: "tc-mid", name: "write", arguments: { path: "notes.md", content: "done" } },
			{ timestamp: 0 },
		);
		const [delta] = sendProjected(
			viewer,
			projector,
			assistantUpdate(
				updatedMessage,
				2,
				{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: 'tes.md","content":"done"}' },
				[{ contentIndex: 0, argsText }],
			),
		);
		expect(delta).not.toHaveProperty("message");

		const rendered = stripAnsi(viewer.render(100).lines.join("\n"));
		expect(rendered).toContain("notes.md");
		grant.reject(new Error("test over"));
	});

	it("renders an authoritative message_end when it is the first observed assistant event", () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, {
			kind: "pending",
			viewerFeedId: "vf-end-only",
			granted: grant.promise,
		});
		const viewer = context.drainViewer as DrainViewerComponent;
		viewer.handleViewerEvent({
			type: "message_end",
			stream: { epoch: 1, seq: 0 },
			message: fauxAssistantMessage("authoritative final reply", { timestamp: 0 }),
		});

		const rendered = stripAnsi(viewer.render(80).lines.join("\n"));
		expect(rendered).toContain("authoritative final reply");
		grant.reject(new Error("test over"));
	});

	it("shows only the spinner after a truncated feed", () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-2", granted: grant.promise });
		const viewer = context.drainViewer as DrainViewerComponent;
		viewer.handleViewerEvent({
			type: "message_start",
			stream: { epoch: 1, seq: 0 },
			message: fauxAssistantMessage("will be dropped", { timestamp: 0 }),
		});
		viewer.handleViewerEvent({ kind: "truncated" });
		viewer.handleViewerEvent({
			type: "message_start",
			stream: { epoch: 2, seq: 0 },
			message: fauxAssistantMessage("ignored after truncation", { timestamp: 0 }),
		});
		const rendered = stripAnsi(viewer.render(80).lines.join("\n"));
		expect(rendered).not.toContain("will be dropped");
		expect(rendered).not.toContain("ignored after truncation");
		expect(rendered).toContain("finishing remote turn");
		grant.reject(new Error("test over"));
	});

	it("disposes pending tool renderers on truncation and finish", () => {
		const disposeSpy = vi.spyOn(ToolExecutionComponent.prototype, "dispose");
		try {
			const startPartialSubagent = (viewer: DrainViewerComponent): void => {
				viewer.handleViewerEvent({
					type: "tool_execution_start",
					toolCallId: "tc-subagent",
					toolName: "subagent",
					args: { agent: "scout", task: "inspect" },
				});
				viewer.handleViewerEvent({
					type: "tool_execution_update",
					toolCallId: "tc-subagent",
					toolName: "subagent",
					partialResult: {
						content: [{ type: "text", text: "running" }],
						details: {
							mode: "single",
							status: "running",
							subagentId: "sa_1",
							sessionId: "session_1",
							agent: { name: "scout" },
						},
					},
				});
			};

			// Truncation forgets the row without a terminal render; its renderer
			// resources (the subagent repaint interval) must be disposed with it.
			const truncatedContext = createContext();
			const truncatedGrant = deferredGrant();
			proto.enterDrainViewer.call(truncatedContext, {
				kind: "pending",
				viewerFeedId: "vf-4",
				granted: truncatedGrant.promise,
			});
			const truncatedViewer = truncatedContext.drainViewer as DrainViewerComponent;
			startPartialSubagent(truncatedViewer);
			expect(disposeSpy).not.toHaveBeenCalled();
			truncatedViewer.handleViewerEvent({ kind: "truncated" });
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			truncatedGrant.reject(new Error("test over"));

			// finish() stops processing events, so still-partial rows are disposed
			// there too.
			disposeSpy.mockClear();
			const finishedContext = createContext();
			const finishedGrant = deferredGrant();
			proto.enterDrainViewer.call(finishedContext, {
				kind: "pending",
				viewerFeedId: "vf-5",
				granted: finishedGrant.promise,
			});
			const finishedViewer = finishedContext.drainViewer as DrainViewerComponent;
			startPartialSubagent(finishedViewer);
			finishedViewer.finish();
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			finishedGrant.reject(new Error("test over"));
		} finally {
			disposeSpy.mockRestore();
		}
	});

	it("keeps input fenced and reports a failed authoritative refresh", async () => {
		const context = createContext();
		const grant = deferredGrant();
		const refreshError = new Error("authoritative refresh failed");
		context.runtimeHost.refreshCurrentSessionFromDisk.mockRejectedValue(refreshError);
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-refresh", granted: grant.promise });

		grant.resolve({ handoff: "warm" });
		await vi.waitFor(() => {
			expect(context.handleRemoteSessionRefreshFailure).toHaveBeenCalledWith(refreshError);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(true);
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
	});

	it("drain failure exits the overlay with a warning instead of taking over", async () => {
		const context = createContext();
		const grant = deferredGrant();
		proto.enterDrainViewer.call(context, { kind: "pending", viewerFeedId: "vf-3", granted: grant.promise });
		grant.reject(new Error("drain_failed"));
		await vi.waitFor(() => {
			expect(context.showWarning).toHaveBeenCalledTimes(1);
		});
		expect(proto.isDrainViewerActive.call(context)).toBe(false);
		expect(context.session.reload).not.toHaveBeenCalled();
	});

	it("quit warns once when a phone is attached mid-turn, then confirms (§6.2)", () => {
		const context = createContext();
		context.session.isStreaming = true;
		context.daemonAttach.relayCount = () => 1;

		expect(proto.confirmQuitWithAttachedPhone.call(context)).toBe(false);
		expect(context.showWarning).toHaveBeenCalledTimes(1);
		// A second quit within the confirmation window proceeds.
		expect(proto.confirmQuitWithAttachedPhone.call(context)).toBe(true);

		// No phone attached or no streaming turn: no warning at all.
		const calm = createContext();
		calm.session.isStreaming = false;
		expect(proto.confirmQuitWithAttachedPhone.call(calm)).toBe(true);
		expect(calm.showWarning).not.toHaveBeenCalled();
	});
});
