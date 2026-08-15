import type { RenderSuspensionLease } from "@hansjm10/volt-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SessionReplacementContext = {
	ui: {
		suspendRendering(): RenderSuspensionLease;
		requestRender(force?: boolean): void;
	};
	sessionRenderSuspension: RenderSuspensionLease | undefined;
	dismissSubagentInspector?: () => void;
	resetExtensionUI(): void;
	rebindCurrentSession(session: AgentSession): Promise<void>;
};

type InteractiveModeSessionReplacementPrototype = {
	beginSessionReplacementUi(this: SessionReplacementContext): void;
	rebindReplacementSession(this: SessionReplacementContext, session: AgentSession): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeSessionReplacementPrototype;

describe("InteractiveMode session replacement rendering", () => {
	it("suspends before teardown and releases after the replacement session is rebound", async () => {
		const order: string[] = [];
		const suspension: RenderSuspensionLease = {
			release: vi.fn(() => order.push("release")),
		};
		let finishRebind: () => void = () => undefined;
		const rebindPending = new Promise<void>((resolve) => {
			finishRebind = resolve;
		});
		const context: SessionReplacementContext = {
			ui: {
				suspendRendering: vi.fn(() => {
					order.push("suspend");
					return suspension;
				}),
				requestRender: vi.fn((force?: boolean) => order.push(`render:${String(force)}`)),
			},
			sessionRenderSuspension: undefined,
			dismissSubagentInspector: vi.fn(() => order.push("dismiss")),
			resetExtensionUI: vi.fn(() => order.push("reset")),
			rebindCurrentSession: vi.fn(async () => {
				order.push("rebind");
				await rebindPending;
			}),
		};
		const replacementSession = {} as AgentSession;

		interactiveModePrototype.beginSessionReplacementUi.call(context);
		expect(order).toEqual(["suspend", "dismiss", "reset"]);

		const replacement = interactiveModePrototype.rebindReplacementSession.call(context, replacementSession);
		await Promise.resolve();
		expect(order).toEqual(["suspend", "dismiss", "reset", "rebind"]);

		finishRebind();
		await replacement;

		expect(context.rebindCurrentSession).toHaveBeenCalledWith(replacementSession);
		expect(order).toEqual(["suspend", "dismiss", "reset", "rebind", "render:true", "release"]);
		expect(context.sessionRenderSuspension).toBeUndefined();
	});

	it("retains the suspension when replacement rebind fails", async () => {
		const rebindError = new Error("rebind failed");
		const suspension: RenderSuspensionLease = { release: vi.fn() };
		const context: SessionReplacementContext = {
			ui: {
				suspendRendering: vi.fn(() => suspension),
				requestRender: vi.fn(),
			},
			sessionRenderSuspension: suspension,
			resetExtensionUI: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {
				throw rebindError;
			}),
		};

		await expect(interactiveModePrototype.rebindReplacementSession.call(context, {} as AgentSession)).rejects.toBe(
			rebindError,
		);

		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(suspension.release).not.toHaveBeenCalled();
		expect(context.sessionRenderSuspension).toBe(suspension);
	});
});
