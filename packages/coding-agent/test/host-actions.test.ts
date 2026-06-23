import { describe, expect, test, vi } from "vitest";
import {
	HostActionRegistry,
	registerBuiltinHostActions,
	SESSION_NEW_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
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
			newSession: vi.fn(async () => ({ cancelled: true })),
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
			newSession,
			afterSessionSwitch,
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
				remoteSafe: false,
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
});
