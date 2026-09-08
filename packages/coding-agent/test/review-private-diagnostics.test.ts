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
	it.each([undefined, "0", "false"])("stays disabled with diagnostics=%s", async (setting) => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, setting);
		const agentDir = createAgentDir();
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:disabled",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["private limitation"]);
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "private challenge" });

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

	it.each([
		{ assessment: "complete" as const },
		{ assessment: "incomplete" as const, challenge: "An omitted defect needs independent verification." },
	])("writes the verifier assessment without limitations: $assessment", async (report) => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:assessment-only",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment(report);

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		expect(await diagnostics.flush()).toBe(filePath);
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toEqual([
			{
				schemaVersion: 1,
				timestamp: expect.any(String),
				runId: "review:assessment-only",
				workflowAction: "review.pr",
				phase: "verification",
				kind: "verification_assessment",
				...report,
			},
		]);
	});

	it("bounds UTF-8 challenge bytes while preserving the assessment", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:bounded-challenge",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "界".repeat(2_000) });

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		const record: unknown = JSON.parse(readFileSync(filePath!, "utf8"));
		expect(record).toMatchObject({ assessment: "incomplete", challenge: expect.stringMatching(/…$/) });
		if (typeof record !== "object" || !record || !("challenge" in record) || typeof record.challenge !== "string")
			throw new Error("Expected a retained challenge");
		expect(Buffer.byteLength(record.challenge, "utf8")).toBeLessThanOrEqual(4_000);
	});

	it("retains the verifier conclusion when tool failures fill the record limit", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:full-log",
			workflowAction: "review.pr",
		});
		for (let index = 0; index < 110; index++) {
			diagnostics.recordToolFailure("verification", { toolName: "review_file", result: {} });
		}
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "Important omitted defect." });
		diagnostics.recordToolFailure("presentation", { toolName: "review_diff", result: {} });

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toHaveLength(100);
		expect(records.at(-1)).toMatchObject({
			kind: "verification_assessment",
			assessment: "incomplete",
			challenge: "Important omitted defect.",
		});
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
