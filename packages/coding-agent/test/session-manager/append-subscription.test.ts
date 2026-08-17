import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager entry subscriptions", () => {
	it("notifies exactly once after the appended entry is queryable", () => {
		const session = SessionManager.inMemory();
		const observed: string[] = [];
		const unsubscribe = session.subscribeEntries((entry) => {
			expect(session.getEntry(entry.id)).toEqual(entry);
			expect(session.getBranch().at(-1)).toEqual(entry);
			observed.push(entry.id);
		});

		const first = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		unsubscribe();
		const second = session.appendMessage({ role: "user", content: "second", timestamp: 2 });

		expect(observed).toEqual([first]);
		expect(session.getEntry(second)?.id).toBe(second);
	});

	it("isolates listener failures from persistence and later listeners", () => {
		const session = SessionManager.inMemory();
		const healthy = vi.fn();
		session.subscribeEntries(() => {
			throw new Error("observer failed");
		});
		session.subscribeEntries(healthy);

		const id = session.appendMessage({ role: "user", content: "persisted", timestamp: 1 });

		expect(session.getEntry(id)?.id).toBe(id);
		expect(healthy).toHaveBeenCalledOnce();
	});

	it("assigns monotonic commit ordinals and reports branch rebases", () => {
		const session = SessionManager.inMemory();
		const first = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const changes: Array<{ previousLeafId: string | null; nextLeafId: string | null }> = [];
		session.subscribeBranchChanges((change) => changes.push(change));

		session.branch(first);
		const fork = session.appendMessage({ role: "user", content: "fork", timestamp: 3 });

		expect(session.getEntry(first)?.ordinal).toBe(1);
		expect(session.getEntry(second)?.ordinal).toBe(2);
		expect(session.getEntry(fork)?.ordinal).toBe(4);
		expect(changes).toEqual([{ previousLeafId: second, nextLeafId: first }]);
	});
});
