import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, test, vi } from "vitest";
import {
	AGENT_MODE_ACTION_ID,
	CONTEXT_COMPACT_ACTION_ID,
	CONTEXT_COMPACT_SLASH_ALIAS,
	HostActionRegistry,
	isRemoteSafeBuiltinHostActionId,
	PLAN_CHANGE_ACTION_ID,
	PLAN_DISCARD_ACTION_ID,
	PLAN_EXECUTE_ACTION_ID,
	REVIEW_BRANCH_ACTION_ID,
	REVIEW_COMMIT_ACTION_ID,
	REVIEW_EXPORT_FEEDBACK_ACTION_ID,
	REVIEW_FEEDBACK_ACTION_ID,
	REVIEW_FIX_ACTION_ID,
	REVIEW_PR_ACTION_ID,
	REVIEW_PUBLISH_ACTION_ID,
	REVIEW_RERUN_ACTION_ID,
	REVIEW_UNCOMMITTED_ACTION_ID,
	RUN_CANCEL_ACTION_ID,
	registerBuiltinHostActions,
	SESSION_NEW_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_ACTION_ID,
	SESSION_RENAME_SLASH_ALIAS,
	THINKING_FAST_MODE_ACTION_ID,
	THINKING_FAST_MODE_SLASH_ALIAS,
} from "../src/core/host-actions.ts";
import type { ReviewWorkflowResult } from "../src/core/review.ts";

describe("HostActionRegistry", () => {
	test("registers descriptors, availability checks, slash aliases, and handlers", async () => {
		const handler = vi.fn(async () => ({
			action: "test.disabled",
			status: "completed" as const,
		}));
		const registry = new HostActionRegistry().register({
			id: "test.disabled",
			label: "Disabled action",
			description: "Cannot run right now",
			category: "session",
			presentation: { kind: "palette", group: "Tests" },
			args: [{ name: "note", label: "Note", type: "string", required: false }],
			remoteSafe: true,
			slashAliases: [{ name: "disabled", example: "/disabled" }],
			availability: () => ({ enabled: false, disabledReason: "Action is disabled for this session" }),
			handler,
		});

		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		expect(registry.getDescriptors(context)).toEqual([
			expect.objectContaining({
				id: "test.disabled",
				label: "Disabled action",
				source: "builtin",
				sourceLabel: "Built in",
				enabled: false,
				disabledReason: "Action is disabled for this session",
				args: [expect.objectContaining({ name: "note", type: "string" })],
				slash: { name: "disabled", example: "/disabled" },
			}),
		]);
		expect(registry.resolveSlashAlias("/disabled")?.id).toBe("test.disabled");
		expect(registry.getSlashCommand("disabled")).toEqual({
			name: "disabled",
			description: "Cannot run right now",
		});
		await expect(registry.invokeBySlashAlias("disabled", context)).rejects.toThrow(
			"Action is disabled for this session",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	test("registers the built-in new session action", async () => {
		const afterSessionSwitch = vi.fn(async () => {});
		const newSession = vi.fn(async () => ({ cancelled: false, seeded: false }));
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession,
			afterSessionSwitch,
			renameSession: vi.fn(() => {}),
		};

		expect(registry.getSlashCommand(SESSION_NEW_SLASH_ALIAS)).toEqual({
			name: SESSION_NEW_SLASH_ALIAS,
			description: "Start a new session",
		});

		const descriptor = registry.getDescriptor(SESSION_NEW_ACTION_ID, context);
		expect(descriptor).toEqual(
			expect.objectContaining({
				id: SESSION_NEW_ACTION_ID,
				label: "New session",
				source: "builtin",
				category: "session",
				remoteSafe: true,
				slash: { name: SESSION_NEW_SLASH_ALIAS, example: "/clear" },
			}),
		);
		await expect(registry.invokeBySlashAlias(SESSION_NEW_SLASH_ALIAS, context)).resolves.toEqual({
			action: SESSION_NEW_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
		});
		expect(newSession).toHaveBeenCalledWith(undefined);
		expect(afterSessionSwitch).toHaveBeenCalledOnce();
	});

	test("validates descriptor argument schema subset before invoking handlers", async () => {
		const handler = vi.fn(async () => ({
			action: "test.schema",
			status: "completed" as const,
		}));
		const registry = new HostActionRegistry().register({
			id: "test.schema",
			label: "Schema action",
			category: "advanced",
			presentation: { kind: "palette", group: "Tests" },
			args: [
				{ name: "message", label: "Message", type: "string", required: true, multiline: true },
				{ name: "enabled", label: "Enabled", type: "boolean", required: true },
				{
					name: "target",
					label: "Target",
					type: "enum",
					required: true,
					options: [
						{ value: "prod", label: "Production" },
						{ value: "staging", label: "Staging" },
					],
				},
				{ name: "retries", label: "Retries", type: "integer", required: false },
			],
			remoteSafe: true,
			handler,
		});
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		await expect(
			registry.invoke("test.schema", context, {
				message: "Ship it",
				enabled: true,
				target: "prod",
				retries: 2,
			}),
		).resolves.toEqual({ action: "test.schema", status: "completed" });
		expect(handler).toHaveBeenCalledWith(
			context,
			{ message: "Ship it", enabled: true, target: "prod", retries: 2 },
			{},
		);
		await expect(
			registry.invoke("test.schema", context, { message: "Ship it", enabled: true, target: "dev" }),
		).rejects.toThrow('UI action argument "target" must be one of: prod, staging');
		await expect(
			registry.invoke("test.schema", context, {
				message: "Ship it",
				enabled: true,
				target: "prod",
				retries: 1.5,
			}),
		).rejects.toThrow('UI action argument "retries" must be an integer');
		await expect(registry.invoke("test.schema", context, { enabled: true, target: "prod" })).rejects.toThrow(
			"Missing required UI action argument: message",
		);
	});

	test("registers cancel, compact, and rename built-ins", async () => {
		const abortRun = vi.fn(async () => {});
		const compactContext = vi.fn(async () => createCompactionResult());
		const renameSession = vi.fn(() => {});
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: true, isCompacting: false },
			abortRun,
			compactContext,
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession,
		};

		const descriptors = registry.getDescriptors(context);
		expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
			AGENT_MODE_ACTION_ID,
			PLAN_EXECUTE_ACTION_ID,
			PLAN_CHANGE_ACTION_ID,
			PLAN_DISCARD_ACTION_ID,
			SESSION_NEW_ACTION_ID,
			RUN_CANCEL_ACTION_ID,
			CONTEXT_COMPACT_ACTION_ID,
			SESSION_RENAME_ACTION_ID,
			THINKING_FAST_MODE_ACTION_ID,
			REVIEW_UNCOMMITTED_ACTION_ID,
			REVIEW_BRANCH_ACTION_ID,
			REVIEW_PR_ACTION_ID,
			REVIEW_COMMIT_ACTION_ID,
			REVIEW_FIX_ACTION_ID,
			REVIEW_FEEDBACK_ACTION_ID,
			REVIEW_RERUN_ACTION_ID,
			REVIEW_PUBLISH_ACTION_ID,
			REVIEW_EXPORT_FEEDBACK_ACTION_ID,
		]);
		expect(descriptors.find((descriptor) => descriptor.id === RUN_CANCEL_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Cancel run",
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "immediate",
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === CONTEXT_COMPACT_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Compact context",
				remoteSafe: false,
				slash: { name: CONTEXT_COMPACT_SLASH_ALIAS, example: "/compact" },
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === SESSION_RENAME_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Rename session",
				remoteSafe: false,
				slash: { name: SESSION_RENAME_SLASH_ALIAS, example: "/name <name>" },
			}),
		);

		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, context, {})).resolves.toEqual({
			action: RUN_CANCEL_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Run cancelled",
		});
		await expect(
			registry.invokeBySlashAlias(CONTEXT_COMPACT_SLASH_ALIAS, context, {
				customInstructions: "preserve todo list",
			}),
		).resolves.toEqual({
			action: CONTEXT_COMPACT_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Context compacted",
		});
		await expect(
			registry.invokeBySlashAlias(SESSION_RENAME_SLASH_ALIAS, context, { name: "  D.2 work  " }),
		).resolves.toEqual({
			action: SESSION_RENAME_ACTION_ID,
			status: "completed",
			stateChanged: true,
			message: "Session name set: D.2 work",
		});
		expect(abortRun).toHaveBeenCalledOnce();
		expect(compactContext).toHaveBeenCalledWith("preserve todo list");
		expect(renameSession).toHaveBeenCalledWith("D.2 work");
	});

	test("registers Fast mode as a remote-safe session-local priority toggle", async () => {
		let fastModeEnabled = false;
		const setFastModeEnabled = vi.fn((enabled: boolean) => {
			fastModeEnabled = enabled;
		});
		const session = {
			isStreaming: false,
			isCompacting: false,
			model: createModel(),
			thinkingLevel: "high" as const,
			get fastModeEnabled() {
				return fastModeEnabled;
			},
		};
		const context = {
			session,
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			setFastModeEnabled,
		};
		const registry = registerBuiltinHostActions(new HostActionRegistry());

		expect(registry.getDescriptor(THINKING_FAST_MODE_ACTION_ID, context)).toEqual(
			expect.objectContaining({
				id: THINKING_FAST_MODE_ACTION_ID,
				label: "Fast mode",
				description: "Request premium low-latency inference capacity for the current session.",
				category: "model",
				presentation: { kind: "toggle", group: "Model", priority: 100 },
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "disabled",
				slash: { name: THINKING_FAST_MODE_SLASH_ALIAS, example: "/fast [on|off]" },
				args: [expect.objectContaining({ name: "enabled", type: "boolean", required: true })],
				state: { type: "boolean", value: false, label: "Fast mode disabled" },
			}),
		);

		await expect(
			registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: true }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode enabled. Priority processing may cost more.",
		});
		expect(session.thinkingLevel).toBe("high");

		await expect(
			registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: false }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: false, label: "Fast mode disabled" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode disabled",
		});
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		expect(session.thinkingLevel).toBe("high");
	});

	test("registers review actions as remote-safe cards with shared handlers", async () => {
		const runReviewAction = vi.fn(async () => createCompletedReviewResult());
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			runReviewAction,
		};

		const descriptors = registry.getDescriptors(context);
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_UNCOMMITTED_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review changes",
				category: "review",
				presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review uncommitted" },
				streamingBehavior: "disabled",
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_BRANCH_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review branch",
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 90 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review branch [base]" },
				args: expect.arrayContaining([
					expect.objectContaining({ name: "base", type: "string", required: false, completion: "gitBranches" }),
				]),
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_PR_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review pull request",
				description: expect.stringContaining("GitHub credentials and network"),
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 80 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review pr [number]" },
				args: expect.arrayContaining([
					expect.objectContaining({ name: "number", type: "string", required: false }),
				]),
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_COMMIT_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review commit",
				description: expect.stringContaining("workspace history"),
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 70 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review commit <ref>" },
				args: expect.arrayContaining([expect.objectContaining({ name: "ref", type: "string", required: true })]),
			}),
		);

		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, context, {})).resolves.toEqual({
			action: REVIEW_UNCOMMITTED_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});
		await expect(
			registry.invoke(REVIEW_BRANCH_ACTION_ID, context, { base: "  main  " }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: REVIEW_BRANCH_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});
		await expect(
			registry.invoke(REVIEW_PR_ACTION_ID, context, { number: " 42 " }, { requireRemoteSafe: true }),
		).resolves.toMatchObject({ action: REVIEW_PR_ACTION_ID, status: "completed" });
		await expect(
			registry.invoke(REVIEW_COMMIT_ACTION_ID, context, { ref: "HEAD~1" }, { requireRemoteSafe: true }),
		).resolves.toMatchObject({ action: REVIEW_COMMIT_ACTION_ID, status: "completed" });
		runReviewAction.mockResolvedValueOnce(createCompletedReviewResult(0, "incomplete"));
		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, context, {})).resolves.toMatchObject({
			message: "Review incomplete; fresh session created with findings",
		});

		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "uncommitted" },
			{ remote: false, requireConfirmation: false, controls: {} },
		);
		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "branch", base: "main" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "pr", number: "42" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "commit", sha: "HEAD~1" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
	});

	test("keeps review feedback export local-only", async () => {
		const runReviewLifecycleAction = vi.fn(async () => ({
			action: REVIEW_EXPORT_FEEDBACK_ACTION_ID,
			status: "completed" as const,
		}));
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			runReviewLifecycleAction,
		};

		expect(registry.getDescriptor(REVIEW_EXPORT_FEEDBACK_ACTION_ID, context)).toEqual(
			expect.objectContaining({ remoteSafe: false }),
		);
		expect(isRemoteSafeBuiltinHostActionId(REVIEW_EXPORT_FEEDBACK_ACTION_ID)).toBe(false);
		await expect(
			registry.invoke(
				REVIEW_EXPORT_FEEDBACK_ACTION_ID,
				context,
				{ path: "../../package.json" },
				{ requireRemoteSafe: true },
			),
		).rejects.toThrow(`UI action not available over remote host: ${REVIEW_EXPORT_FEEDBACK_ACTION_ID}`);
		expect(runReviewLifecycleAction).not.toHaveBeenCalled();

		await expect(
			registry.invoke(REVIEW_EXPORT_FEEDBACK_ACTION_ID, context, { path: "review-feedback.json" }),
		).resolves.toEqual({ action: REVIEW_EXPORT_FEEDBACK_ACTION_ID, status: "completed" });
		expect(runReviewLifecycleAction).toHaveBeenCalledWith(REVIEW_EXPORT_FEEDBACK_ACTION_ID, {
			path: "review-feedback.json",
		});
	});

	test("rechecks built-in availability and validates arguments at invocation time", async () => {
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const idleContext = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, idleContext, {})).rejects.toThrow("No active run to cancel");

		const preflightContext = {
			...idleContext,
			session: { isBusy: true, isStreaming: false, isCompacting: false },
		};
		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, preflightContext, {})).resolves.toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, preflightContext, {})).rejects.toThrow(
			"Review is not available while an agent operation is running",
		);
		await expect(registry.invoke(THINKING_FAST_MODE_ACTION_ID, preflightContext, { enabled: true })).rejects.toThrow(
			"Fast mode is not available while an agent operation is running",
		);

		await expect(
			registry.invokeBySlashAlias(SESSION_RENAME_SLASH_ALIAS, idleContext, { name: "   " }),
		).rejects.toThrow("Session name cannot be empty");
		await expect(
			registry.invokeBySlashAlias(CONTEXT_COMPACT_SLASH_ALIAS, idleContext, { unexpected: true }),
		).rejects.toThrow("Unsupported UI action argument: unexpected");
		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, idleContext, { unexpected: true })).rejects.toThrow(
			"Unsupported UI action argument: unexpected",
		);
		await expect(
			registry.invoke(
				THINKING_FAST_MODE_ACTION_ID,
				{
					...idleContext,
					session: {
						isStreaming: false,
						isCompacting: false,
						model: createModel(),
						thinkingLevel: "high",
					},
					setFastModeEnabled: vi.fn(() => {}),
				},
				{ enabled: "yes" },
			),
		).rejects.toThrow('UI action argument "enabled" must be a boolean');
		await expect(registry.invoke(REVIEW_PR_ACTION_ID, idleContext, { number: null })).rejects.toThrow(
			'UI action argument "number" must be a string',
		);
		await expect(
			registry.invoke(
				REVIEW_BRANCH_ACTION_ID,
				{
					...idleContext,
					session: { isStreaming: true, isCompacting: false },
				},
				{},
			),
		).rejects.toThrow("Review is not available while the agent is streaming");
	});
});

function createCompactionResult() {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

function createCompletedReviewResult(
	findingsCount = 2,
	completionStatus: "complete" | "incomplete" = "complete",
): Extract<ReviewWorkflowResult, { status: "completed" }> {
	return {
		status: "completed",
		resolution: {
			identity: { kind: "uncommitted", baseTree: "a".repeat(40), headTree: "b".repeat(40) },
			changedFiles: [],
			root: "/tmp/review",
			description: "uncommitted changes",
			workflowDescription: "uncommitted changes",
			diffCommand: "git diff HEAD",
			readFile: async () => undefined,
			listFiles: async () => [],
			inspectSearch: async () => ({ entries: [] }),
			gitGrep: async () => [],
			materializeSearch: async () => ({
				directory: "/tmp/review-search",
				entries: [],
				materializedFiles: 0,
				materializedBytes: 0,
			}),
			materializeHead: async () => "/tmp/review",
			dispose: async () => {},
		},
		findingsCount,
		completionStatus,
		sessionSwitchCancelled: false,
	};
}

function createModel(): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}
