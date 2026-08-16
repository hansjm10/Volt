import { stdout } from "node:process";
import { setImmediate } from "node:timers";
import type { ProjectionCursor, SessionStorageBranchSnapshot } from "@hansjm10/volt-agent-core";
import { SessionManagerHarnessStorage } from "../../src/core/harness-session-adapter.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function forceGc(): void {
	const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
	if (!gc) throw new Error("GC fixture requires --expose-gc");
	gc();
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function advanceFromHeldCursor(storage: SessionManagerHarnessStorage, cursor: ProjectionCursor): Promise<void> {
	const result = await storage.commitBatch({
		guard: { kind: "exact", cursor },
		mutations: [{ kind: "append", entry: { type: "custom", customType: "held-cursor-boundary" } }],
	});
	if (result.outcome !== "committed") throw result.error;
}

async function createStaleCursorReferences(
	storage: SessionManagerHarnessStorage,
	count: number,
): Promise<Array<WeakRef<ProjectionCursor>>> {
	const references: Array<WeakRef<ProjectionCursor>> = [];
	let snapshot = await storage.getBranchSnapshot();
	for (let index = 0; index < count; index++) {
		const cursor = snapshot.cursor;
		const result = await storage.commitBatch({
			guard: { kind: "exact", cursor },
			mutations: [
				{
					kind: "append",
					entry: {
						type: "custom",
						customType: "gc-retention-probe",
						data: { index, payload: "x".repeat(512) },
					},
				},
			],
		});
		if (result.outcome !== "committed") throw result.error;
		references.push(new WeakRef(cursor));
		snapshot = result.record.after;
	}
	return references;
}

async function collectStaleCursors(references: ReadonlyArray<WeakRef<ProjectionCursor>>): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt++) {
		await nextTurn();
		forceGc();
		await nextTurn();
		const collected = references.filter((reference) => reference.deref() === undefined).length;
		if (collected === references.length) return collected;
	}
	return references.filter((reference) => reference.deref() === undefined).length;
}

const manager = SessionManager.inMemory("/workspace");
const storage = new SessionManagerHarnessStorage(manager);
const heldSnapshot: SessionStorageBranchSnapshot = await storage.getBranchSnapshot();
await advanceFromHeldCursor(storage, heldSnapshot.cursor);

const staleReferences = await createStaleCursorReferences(storage, 48);
const collected = await collectStaleCursors(staleReferences);
if (collected !== staleReferences.length) {
	throw new Error(`Expected ${staleReferences.length} stale cursors to be collected, observed ${collected}`);
}

const heldReread = await storage.getBranchSnapshot(heldSnapshot.cursor);
if (heldReread.entries.length !== heldSnapshot.entries.length) {
	throw new Error("A caller-retained cursor no longer resolves its original snapshot");
}

const descendant = await storage.commitBatch({
	guard: { kind: "descendant", cursor: heldSnapshot.cursor },
	mutations: [{ kind: "append", entry: { type: "custom", customType: "held-cursor-still-valid" } }],
});
if (descendant.outcome !== "committed") throw descendant.error;

stdout.write(
	`${JSON.stringify({ collected, heldEntries: heldReread.entries.length, descendant: descendant.outcome })}\n`,
);
