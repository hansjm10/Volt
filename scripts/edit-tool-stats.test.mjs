import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statsScript = join(scriptsDir, "edit-tool-stats.mjs");

test("classifies single and indexed edit misses as exact-text not-found failures", () => {
	const sessionsDir = mkdtempSync(join(tmpdir(), "volt-edit-tool-stats-"));
	const sessionFile = join(sessionsDir, "session.jsonl");
	const entries = [
		{
			type: "message",
			id: "assistant-single",
			message: {
				role: "assistant",
				provider: "test",
				model: "test-model",
				content: [
					{
						type: "toolCall",
						id: "edit-single",
						name: "edit",
						arguments: {
							path: "single.ts",
							edits: [{ oldText: "missing", newText: "replacement" }],
						},
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "edit",
				toolCallId: "edit-single",
				isError: true,
				content: [{ type: "text", text: "Could not find the exact text in single.ts." }],
			},
		},
		{
			type: "message",
			id: "assistant-multi",
			message: {
				role: "assistant",
				provider: "test",
				model: "test-model",
				content: [
					{
						type: "toolCall",
						id: "edit-multi",
						name: "edit",
						arguments: {
							path: "multi.ts",
							edits: [
								{ oldText: "present", newText: "changed" },
								{ oldText: "missing", newText: "replacement" },
							],
						},
					},
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "edit",
				toolCallId: "edit-multi",
				isError: true,
				content: [{ type: "text", text: "Could not find edits[1] in multi.ts." }],
			},
		},
	];

	try {
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const result = spawnSync(
			process.execPath,
			[statsScript, "--sessions-dir", sessionsDir, "--all-sessions", "--json"],
			{ encoding: "utf8" },
		);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const output = JSON.parse(result.stdout);
		assert.deepEqual(output.summary.failureKinds, [{ kind: "not_found_exact_text", count: 2 }]);
	} finally {
		rmSync(sessionsDir, { recursive: true, force: true });
	}
});
