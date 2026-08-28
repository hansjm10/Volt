import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReviewPrivateDiagnostics,
	getReviewPrivateDiagnosticsDirectory,
	MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES,
	REVIEW_PRIVATE_DIAGNOSTICS_ENV,
} from "../src/core/review-private-diagnostics.ts";

const roots: string[] = [];

function createAgentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-review-private-diagnostics-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return agentDir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private review diagnostics", () => {
	it("stays disabled unless the private diagnostics environment setting is enabled", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "0");
		const agentDir = createAgentDir();
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:disabled",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["private limitation"]);

		await expect(diagnostics.flush()).resolves.toBeUndefined();
		expect(existsSync(getReviewPrivateDiagnosticsDirectory(agentDir))).toBe(false);
	});

	it("writes bounded model limitations and failed tool output to an owner-only per-run JSONL file", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createAgentDir();
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:private-details",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["Discovery could not run the focused test."]);
		diagnostics.recordModelLimitations("verification", ["Verification was limited to static inspection."]);
		diagnostics.recordToolFailure("verification", {
			toolName: "review_read_file",
			result: { content: [{ type: "text", text: `failed: ${"x".repeat(5_000)}` }] },
		});

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		expect(await diagnostics.flush()).toBe(filePath);
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toEqual([
			expect.objectContaining({
				kind: "model_limitation",
				phase: "discovery",
				message: "Discovery could not run the focused test.",
				runId: "review:private-details",
			}),
			expect.objectContaining({
				kind: "model_limitation",
				phase: "verification",
				message: "Verification was limited to static inspection.",
			}),
			expect.objectContaining({
				kind: "tool_failure",
				phase: "verification",
				toolName: "review_read_file",
				result: expect.stringMatching(/…$/),
			}),
		]);
		if (process.platform !== "win32") {
			expect(statSync(getReviewPrivateDiagnosticsDirectory(agentDir)).mode & 0o777).toBe(0o700);
			expect(statSync(filePath!).mode & 0o777).toBe(0o600);
		}
	});

	it("retains only the newest bounded set of per-run files", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "true");
		const agentDir = createAgentDir();
		for (let index = 0; index <= MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES; index++) {
			const diagnostics = createReviewPrivateDiagnostics({
				agentDir,
				workflowId: `review:retention-${index}`,
				workflowAction: "review.pr",
			});
			diagnostics.recordModelLimitations("discovery", [`limitation ${index}`]);
			await diagnostics.flush();
		}

		expect(readdirSync(getReviewPrivateDiagnosticsDirectory(agentDir))).toHaveLength(
			MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES,
		);
	});
});
