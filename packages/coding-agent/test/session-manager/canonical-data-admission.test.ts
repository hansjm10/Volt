import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const cleanups: Array<{ manager: SessionManager; root: string }> = [];
const managerOwner = createSessionManagerTestOwner();

async function createManager(): Promise<{ manager: SessionManager; root: string; ref: SessionReference }> {
	const root = mkdtempSync(join(tmpdir(), "volt-canonical-session-"));
	const manager = await SessionManager.create(root, root);
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected a persisted session reference");
	cleanups.push({ manager, root });
	return { manager, root, ref };
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const { root } of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionManager canonical data admission", () => {
	it("rejects invalid values before state, persistence, ordinals, or observers change", async () => {
		const { manager, ref } = await createManager();
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;

		for (const [label, data] of [
			["cycle", cyclic],
			["map", { value: new Map([["key", "value"]]) }],
			["undefined", { value: undefined }],
			["shared-memory", { value: new SharedArrayBuffer(1) }],
		] as const) {
			expect(() => manager.appendCustomEntry(label, data as never)).toThrow(
				"Session custom entry must contain only JSON-compatible data",
			);
			expect(manager.getEntries()).toEqual([]);
			expect(manager.getLeafId()).toBeNull();
			expect(observed).toEqual([]);
		}

		const id = manager.appendCustomEntry("valid", { nested: { values: [1, "two", true, null] } });
		await manager.flush();
		expect(manager.getEntry(id)?.ordinal).toBe(1);
		expect(observed).toEqual([id]);
		expect((await SessionManager.open(ref)).getEntries()).toHaveLength(1);
	});

	it("owns valid input and round-trips it exactly through SQLite reopen", async () => {
		const { manager, ref } = await createManager();
		const data = { nested: { values: [1, "two", true, null] } };
		const expected = structuredClone(data);
		manager.subscribeEntries((entry) => {
			if (entry.type !== "custom") return;
			(entry.data as { nested: { values: unknown[] } }).nested.values[0] = "observer mutation";
		});
		const id = manager.appendCustomEntry("valid", data);
		manager.appendCustomMessageEntry("flush", "materialize session", true);
		data.nested.values[0] = 99;

		await manager.flush();
		const inMemory = manager.getEntry(id);
		expect(inMemory?.type).toBe("custom");
		if (inMemory?.type !== "custom") throw new Error("Expected custom entry");
		expect(inMemory.data).toEqual(expected);

		const persisted = (await SessionManager.open(ref)).getEntry(id);
		expect(persisted?.type).toBe("custom");
		if (persisted?.type !== "custom") throw new Error("Expected reopened custom entry");
		expect(persisted.data).toEqual(expected);
	});

	it("prevalidates branch summaries before moving the active leaf", async () => {
		const { manager } = await createManager();
		const firstId = manager.appendCustomMessageEntry("first", "first", true);
		const secondId = manager.appendCustomMessageEntry("second", "second", true);
		expect(manager.getLeafId()).toBe(secondId);

		expect(() =>
			manager.branchWithSummary(firstId, "summary", { shared: new SharedArrayBuffer(1) } as never),
		).toThrow("Session branch_summary entry must contain only JSON-compatible data");
		expect(manager.getLeafId()).toBe(secondId);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([firstId, secondId]);
	});
});
