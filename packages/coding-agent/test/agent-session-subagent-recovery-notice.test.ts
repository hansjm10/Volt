/**
 * Issue #129 §4: after a reload, the first prompt surfaces completed-but-
 * unclaimed subagent results recovered by registry hydration as one persisted
 * custom-message notice, deduplicated durably against notices already in the
 * transcript.
 */

import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE } from "../src/core/agent-session.ts";
import type { CustomMessageEntry } from "../src/core/session-manager.ts";
import type { SubagentRegistryRecord } from "../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../src/core/tools/index.ts";
import { createHarness } from "./test-harness.ts";

function record(overrides: Partial<SubagentRegistryRecord> & { id: string }): SubagentRegistryRecord {
	return {
		sequence: 0,
		agent: { name: "researcher" },
		path: ["researcher"],
		status: "completed",
		hydrated: true,
		startedAt: 1,
		finishedAt: 2,
		...overrides,
	};
}

function createStubManager(
	records: SubagentRegistryRecord[],
	options: { isSubagentRuntime?: boolean } = {},
): {
	manager: SubagentToolManager;
	hydrateCalls: () => number;
} {
	const ensureRegistryHydrated = vi.fn(async () => {});
	const manager: SubagentToolManager = {
		getDefinition: () => {
			throw new Error("not used");
		},
		startByName: () => {
			throw new Error("not used");
		},
		isSubagentRuntime: () => options.isSubagentRuntime === true,
		ensureRegistryHydrated,
		listDelegations: () => records,
	};
	return { manager, hydrateCalls: () => ensureRegistryHydrated.mock.calls.length };
}

function noticeEntries(harness: { sessionManager: { getEntries(): Array<{ type: string }> } }): CustomMessageEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomMessageEntry =>
				entry.type === "custom_message" &&
				(entry as CustomMessageEntry).customType === SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
		);
}

describe("subagent recovery notice", () => {
	it("offers unclaimed completed recoveries once, before the first user message", async () => {
		const { manager, hydrateCalls } = createStubManager([
			record({ id: "sa_unclaimed", task: "inspect\nthe   incident" }),
			record({ id: "sa_interrupted", status: "aborted", error: "Interrupted before completion" }),
			record({ id: "sa_claimed", claimed: true }),
			record({ id: "sa_stranded", stranded: true }),
			record({ id: "sa_live", hydrated: undefined, status: "completed" }),
		]);
		const harness = createHarness({ responses: ["ok", "ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("hello");

			const notices = noticeEntries(harness);
			expect(notices).toHaveLength(1);
			expect(notices[0].details).toEqual({ subagentIds: ["sa_unclaimed"] });
			const text = notices[0].content as string;
			expect(text).toContain("sa_unclaimed");
			expect(text).toContain("inspect the incident");
			expect(text).not.toContain("sa_interrupted");
			expect(text).not.toContain("sa_claimed");
			expect(text).not.toContain("sa_stranded");
			expect(text).not.toContain("sa_live");
			expect(text).toContain('{ "follow": "<id>" }');

			// The feature's point: the model sees the notice in THIS turn's
			// provider context, not after the next reload. Custom messages reach
			// the provider transformed, so assert on the notice text.
			const firstTurnContext = JSON.stringify(harness.faux.contexts[0]?.messages ?? []);
			expect(firstTurnContext).toContain("Subagent recovery:");
			expect(firstTurnContext).toContain("sa_unclaimed");

			// Live clients observe the notice through message events at append
			// time, not only via a later transcript reload.
			expect(
				harness.events.some(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "custom" &&
						event.message.customType === SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
				),
			).toBe(true);

			// The notice precedes the user message in entry order.
			const entries = harness.sessionManager.getEntries();
			const noticeIndex = entries.findIndex((entry) => entry.id === notices[0].id);
			const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(noticeIndex).toBeLessThan(userIndex);

			// One-shot: a second prompt neither re-hydrates nor re-notices.
			await harness.session.prompt("again");
			expect(noticeEntries(harness)).toHaveLength(1);
			expect(hydrateCalls()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("durably skips runs already offered by a persisted notice", async () => {
		const { manager } = createStubManager([record({ id: "sa_old" }), record({ id: "sa_new", task: "new work" })]);
		const harness = createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			// A notice persisted by a previous process already offered sa_old.
			harness.sessionManager.appendCustomMessageEntry(SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE, "prior notice", true, {
				subagentIds: ["sa_old"],
			});

			await harness.session.prompt("hello");

			const notices = noticeEntries(harness);
			expect(notices).toHaveLength(2);
			expect(notices[1].details).toEqual({ subagentIds: ["sa_new"] });
			expect(notices[1].content as string).not.toContain("sa_old");
		} finally {
			harness.cleanup();
		}
	});

	it("appends nothing when hydration recovers no unclaimed work", async () => {
		const { manager } = createStubManager([record({ id: "sa_claimed", claimed: true })]);
		const harness = createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("hello");
			expect(noticeEntries(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("never leaks a root-registry notice into a subagent child runtime", async () => {
		// Children share the root registry, so recovered root work is visible
		// through listDelegations — but a child transcript must stay clean.
		const { manager, hydrateCalls } = createStubManager([record({ id: "sa_unclaimed" })], {
			isSubagentRuntime: true,
		});
		const harness = createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("do the delegated task");
			expect(noticeEntries(harness)).toHaveLength(0);
			expect(hydrateCalls()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
