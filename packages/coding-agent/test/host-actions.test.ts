import { describe, expect, test, vi } from "vitest";
import {
	CONTEXT_COMPACT_ACTION_ID,
	CONTEXT_COMPACT_SLASH_ALIAS,
	HostActionRegistry,
	RUN_CANCEL_ACTION_ID,
	registerBuiltinHostActions,
	SESSION_NEW_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_ACTION_ID,
	SESSION_RENAME_SLASH_ALIAS,
} from "../src/core/host-actions.ts";

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
			newSession: vi.fn(async () => ({ cancelled: true })),
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
		const newSession = vi.fn(async () => ({ cancelled: false }));
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

		const [descriptor] = registry.getDescriptors(context);
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

	test("registers cancel, compact, and rename built-ins", async () => {
		const abortRun = vi.fn(async () => {});
		const compactContext = vi.fn(async () => createCompactionResult());
		const renameSession = vi.fn(() => {});
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: true, isCompacting: false },
			abortRun,
			compactContext,
			newSession: vi.fn(async () => ({ cancelled: true })),
			renameSession,
		};

		const descriptors = registry.getDescriptors(context);
		expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
			SESSION_NEW_ACTION_ID,
			RUN_CANCEL_ACTION_ID,
			CONTEXT_COMPACT_ACTION_ID,
			SESSION_RENAME_ACTION_ID,
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

	test("rechecks built-in availability and validates arguments at invocation time", async () => {
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const idleContext = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true })),
			renameSession: vi.fn(() => {}),
		};

		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, idleContext, {})).rejects.toThrow("No active run to cancel");
		await expect(
			registry.invokeBySlashAlias(SESSION_RENAME_SLASH_ALIAS, idleContext, { name: "   " }),
		).rejects.toThrow("Session name cannot be empty");
		await expect(
			registry.invokeBySlashAlias(CONTEXT_COMPACT_SLASH_ALIAS, idleContext, { unexpected: true }),
		).rejects.toThrow("Unsupported UI action argument: unexpected");
	});
});

function createCompactionResult() {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}
