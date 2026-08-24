import { type Component, Container, setKeybindings, Text, type TUI } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ReviewWorkflowHooks, ReviewWorkflowOptions, ReviewWorkflowResult } from "../src/core/review.ts";
import { initTheme } from "../src/core/theme/runtime.ts";

const reviewMocks = vi.hoisted(() => ({
	runReviewWorkflow: vi.fn<(options: ReviewWorkflowOptions) => Promise<ReviewWorkflowResult>>(),
}));

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return { ...actual, runReviewWorkflow: reviewMocks.runReviewWorkflow };
});

import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ReviewContext {
	runtimeHost: {
		session: Record<string, unknown>;
		services: { agentDir: string };
		newSession: ReturnType<typeof vi.fn>;
	};
	ui: TUI;
	editorContainer: Container;
	editor: Text;
	footer: { setTransientUsage: ReturnType<typeof vi.fn> };
	activeInteractiveReview: boolean;
	createInlineSessionRenderer: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	activeView: { regularComponents: Component[]; fullscreenRoot: Component };
	conversationView: { regularComponents: Component[]; fullscreenRoot: Component };
	extensionSelector?: { handleInput(data: string): void };
}

function createContext(): ReviewContext {
	setKeybindings(KeybindingsManager.create());
	initTheme("dark", true);
	const editor = new Text("editor");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let focusedComponent: Component | null = editor;
	const ui = {
		terminal: { rows: 24 },
		requestRender: vi.fn(),
		setFocus: vi.fn((component: Component | null) => {
			focusedComponent = component;
		}),
		getFocusedComponent: vi.fn(() => focusedComponent),
		clear: vi.fn(),
		addChild: vi.fn(),
	} as unknown as TUI;
	const sessionManager = { getCwd: () => "/workspace" };
	const session = {
		isStreaming: false,
		isCompacting: false,
		modelRegistry: { authStorage: {} },
		settingsManager: {},
		sessionManager,
		resourceLoader: {},
	};
	const view = { regularComponents: [editorContainer], fullscreenRoot: editorContainer };
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session,
			services: { agentDir: "/workspace/.volt" },
			newSession: vi.fn(),
		},
		ui,
		editorContainer,
		editor,
		footer: { setTransientUsage: vi.fn() },
		activeInteractiveReview: false,
		activeView: view,
		conversationView: view,
		createInlineSessionRenderer: vi.fn(() => ({ onSessionEvent: vi.fn(), dispose: vi.fn() })),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as ReviewContext;
}

const runInteractiveReviewWorkflow = Reflect.get(InteractiveMode.prototype, "runInteractiveReviewWorkflow") as (
	this: ReviewContext,
	target: { kind: "uncommitted" },
	options: {
		tools: readonly string[];
		requireConfirmation: boolean;
		requireProjectTrust: boolean;
	},
) => Promise<ReviewWorkflowResult>;

const resolution = {
	description: "uncommitted changes",
	diffCommand: "git diff",
	identity: { kind: "uncommitted" as const, baseTree: "base", headTree: "head" },
	changedFiles: [],
	root: "/workspace",
	readFile: vi.fn(async () => undefined),
	listFiles: vi.fn(async () => []),
	search: vi.fn(),
	materializeHead: vi.fn(async () => "/tmp/review"),
	dispose: vi.fn(async () => {}),
};

function run(context: ReviewContext, requireConfirmation = false): Promise<ReviewWorkflowResult> {
	return runInteractiveReviewWorkflow.call(
		context,
		{ kind: "uncommitted" },
		{
			tools: [],
			requireConfirmation,
			requireProjectTrust: false,
		},
	);
}

afterEach(() => {
	reviewMocks.runReviewWorkflow.mockReset();
});

describe("InteractiveMode review workflow", () => {
	it("installs and focuses the cancellable loader before preparation resolves", async () => {
		const context = createContext();
		let releasePreparation!: () => void;
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let hooksCreated!: () => void;
		const hooksReady = new Promise<void>((resolve) => {
			hooksCreated = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.();
			hooksCreated();
			await preparationGate;
			await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
			hooks?.cleanup?.();
			return { status: "cancelled", resolution };
		});

		const pending = run(context);
		await hooksReady;
		const loader = context.editorContainer.children[0];
		expect(loader).toBeInstanceOf(BorderedLoader);
		expect(context.ui.setFocus).toHaveBeenCalledWith(loader);
		expect(context.createInlineSessionRenderer).not.toHaveBeenCalled();

		releasePreparation();
		await pending;
		expect(context.createInlineSessionRenderer).toHaveBeenCalledOnce();
		expect(context.editorContainer.children).toEqual([context.editor]);
	});

	it("reattaches and focuses the loader after accepting review confirmation", async () => {
		const context = createContext();
		let loader!: BorderedLoader;
		let releasePrepared!: () => void;
		const preparedGate = new Promise<void>((resolve) => {
			releasePrepared = resolve;
		});
		let prepared!: () => void;
		const preparedReady = new Promise<void>((resolve) => {
			prepared = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			expect(options.requireConfirmation).toBe(true);
			const hooks = await options.createHooks?.();
			loader = context.editorContainer.children[0] as BorderedLoader;
			const confirmed = await options.confirm?.({
				title: "Review changes",
				message: "Confirm rerun",
				resolution,
			});
			expect(confirmed).toBe(true);
			await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
			prepared();
			await preparedGate;
			hooks?.cleanup?.();
			return { status: "cancelled", resolution };
		});

		const pending = run(context, true);
		await vi.waitFor(() => expect(context.extensionSelector).toBeDefined());
		context.extensionSelector?.handleInput("\n");
		await preparedReady;

		expect(context.editorContainer.children).toEqual([loader]);
		expect(context.ui.setFocus).toHaveBeenLastCalledWith(loader);
		expect(context.createInlineSessionRenderer).toHaveBeenCalledOnce();

		releasePrepared();
		await pending;
		expect(context.editorContainer.children).toEqual([context.editor]);
	});

	it("Escape aborts preparation, restores the editor, and prevents promotion or inference", async () => {
		const context = createContext();
		let hooks: ReviewWorkflowHooks | undefined;
		let inferenceCalls = 0;
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			hooks = await options.createHooks?.();
			await new Promise<void>((resolve) => {
				if (hooks?.signal?.aborted) resolve();
				else hooks?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			if (!hooks?.signal?.aborted) {
				await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
				inferenceCalls++;
			}
			hooks?.cleanup?.();
			return { status: "cancelled" };
		});

		const pending = run(context);
		await vi.waitFor(() => expect(context.editorContainer.children[0]).toBeInstanceOf(BorderedLoader));
		const loader = context.editorContainer.children[0] as BorderedLoader;
		loader.handleInput("\u001b");
		await pending;

		expect(hooks?.signal?.aborted).toBe(true);
		expect(context.createInlineSessionRenderer).not.toHaveBeenCalled();
		expect(inferenceCalls).toBe(0);
		expect(context.footer.setTransientUsage).toHaveBeenLastCalledWith(undefined);
		expect(context.editorContainer.children).toEqual([context.editor]);
		expect(context.ui.setFocus).toHaveBeenLastCalledWith(context.editor);
	});

	it("rejects a duplicate local start while the first review is active", async () => {
		const context = createContext();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.();
			await gate;
			hooks?.cleanup?.();
			return { status: "cancelled" };
		});

		const first = run(context);
		await vi.waitFor(() => expect(context.activeInteractiveReview).toBe(true));
		await expect(run(context)).resolves.toEqual({ status: "cancelled" });
		expect(reviewMocks.runReviewWorkflow).toHaveBeenCalledOnce();
		expect(context.showWarning).toHaveBeenCalledWith(
			"A review is already running. Cancel it before starting another.",
		);

		release();
		await first;
		expect(context.activeInteractiveReview).toBe(false);
	});
});
