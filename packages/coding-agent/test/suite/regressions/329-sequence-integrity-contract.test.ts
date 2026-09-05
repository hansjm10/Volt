import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../../../src/core/session-store/index.ts";
import { createHarness, type Harness } from "../harness.ts";

let root: string | undefined;
let harness: Harness | undefined;

afterEach(async () => {
	try {
		await harness?.cleanupAsync();
	} finally {
		harness = undefined;
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	}
});

describe("PR #329 canonical sequence integrity contract", () => {
	it.each(["ordinal gap", "self parent"])("classifies %s corruption without repairing entries", async (corruption) => {
		root = mkdtempSync(join(tmpdir(), "volt-329-sequence-integrity-"));
		const sessionDir = join(root, "sessions");
		const manager = await SessionManager.create(root, sessionDir);
		harness = await createHarness({ sessionManager: manager });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const entryId = manager.appendMessage(fauxAssistantMessage("hello", { timestamp: 2 }));
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		await harness.cleanupAsync();
		harness = undefined;

		const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
		try {
			if (corruption === "ordinal gap") {
				database
					.prepare(
						"UPDATE entries SET ordinal = ordinal + 100, payload_json = json_set(payload_json, '$.ordinal', ordinal + 100) WHERE session_id = ? AND entry_id = ?",
					)
					.run(ref.sessionId, entryId);
			} else {
				database
					.prepare(
						"UPDATE entries SET parent_entry_id = entry_id, payload_json = json_set(payload_json, '$.parentId', entry_id) WHERE session_id = ? AND entry_id = ?",
					)
					.run(ref.sessionId, entryId);
			}
			const before = database
				.prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY ordinal")
				.all(ref.sessionId);
			await expect(SessionManager.open(ref)).rejects.toMatchObject({
				code: "session_store_entry_integrity",
				message: "Session store canonical entries are invalid or inconsistent",
			});
			expect(
				database.prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY ordinal").all(ref.sessionId),
			).toEqual(before);

			const healthy = await SessionManager.create(root, sessionDir);
			try {
				healthy.appendMessage({ role: "user", content: "still usable", timestamp: 3 });
				await healthy.flush();
				const healthyRef = healthy.getSessionRef();
				if (!healthyRef) throw new Error("Expected a healthy session reference");
				const reopened = await SessionManager.open(healthyRef);
				try {
					expect(reopened.getEntries()).toEqual(healthy.getEntries());
				} finally {
					await reopened.drainPersistence();
				}
			} finally {
				await healthy.drainPersistence();
			}
		} finally {
			database.close();
		}
	});
});
