import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectorySync, writePrivateNewFile } from "../utils/private-files.ts";
import type { ReviewPass } from "./review.ts";

export const REVIEW_PRIVATE_DIAGNOSTICS_ENV = "VOLT_REVIEW_PRIVATE_DIAGNOSTICS";
export const MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES = 20;

const MAX_PRIVATE_DIAGNOSTIC_RECORDS = 100;
const MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES = 4_000;
const PRIVATE_DIAGNOSTIC_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{16}\.jsonl$/;

interface ReviewPrivateDiagnosticBase {
	schemaVersion: 1;
	timestamp: string;
	runId: string;
	workflowAction: string;
	phase: ReviewPass;
}

type ReviewPrivateDiagnosticRecord =
	| (ReviewPrivateDiagnosticBase & {
			kind: "model_limitation";
			message: string;
	  })
	| (ReviewPrivateDiagnosticBase & {
			kind: "tool_failure";
			toolName: string;
			command?: string;
			result?: string;
	  });

export interface ReviewPrivateDiagnostics {
	recordModelLimitations(phase: ReviewPass, limitations: readonly string[]): void;
	recordToolFailure(phase: ReviewPass, failure: { toolName: string; command?: string; result: unknown }): void;
	flush(): Promise<string | undefined>;
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const suffix = "…";
	let truncated = Buffer.from(value, "utf8")
		.subarray(0, maximumBytes - Buffer.byteLength(suffix, "utf8"))
		.toString("utf8");
	while (Buffer.byteLength(truncated + suffix, "utf8") > maximumBytes) truncated = truncated.slice(0, -1);
	return truncated + suffix;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		return undefined;
	}
	const text = result.content
		.flatMap((entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "text" &&
			"text" in entry &&
			typeof entry.text === "string"
				? [entry.text]
				: [],
		)
		.join("\n")
		.trim();
	return text ? truncateUtf8(text, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) : undefined;
}

async function prunePrivateDiagnosticFiles(directoryPath: string): Promise<void> {
	const files = (await readdir(directoryPath, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && PRIVATE_DIAGNOSTIC_FILE_PATTERN.test(entry.name))
		.sort((left, right) => right.name.localeCompare(left.name));
	await Promise.all(
		files
			.slice(MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES)
			.map((entry) => rm(join(directoryPath, entry.name), { force: true })),
	);
}

export function getReviewPrivateDiagnosticsDirectory(agentDir: string): string {
	return join(agentDir, "review-diagnostics");
}

export function createReviewPrivateDiagnostics(options: {
	agentDir: string;
	workflowId?: string;
	workflowAction?: string;
}): ReviewPrivateDiagnostics {
	const setting = process.env[REVIEW_PRIVATE_DIAGNOSTICS_ENV]?.toLowerCase();
	if ((setting !== "1" && setting !== "true") || !options.workflowId || !options.workflowAction) {
		return {
			recordModelLimitations: () => {},
			recordToolFailure: () => {},
			flush: () => Promise.resolve(undefined),
		};
	}

	const runId = options.workflowId;
	const workflowAction = options.workflowAction;
	const records: ReviewPrivateDiagnosticRecord[] = [];
	const createdAt = new Date();
	let flushPromise: Promise<string | undefined> | undefined;
	const append = (record: ReviewPrivateDiagnosticRecord): void => {
		if (records.length < MAX_PRIVATE_DIAGNOSTIC_RECORDS) records.push(record);
	};
	const baseRecord = (phase: ReviewPass): ReviewPrivateDiagnosticBase => ({
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		runId,
		workflowAction,
		phase,
	});

	return {
		recordModelLimitations(phase, limitations) {
			for (const limitation of limitations) {
				append({
					...baseRecord(phase),
					kind: "model_limitation",
					message: truncateUtf8(limitation, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES),
				});
			}
		},
		recordToolFailure(phase, failure) {
			const result = toolResultText(failure.result);
			append({
				...baseRecord(phase),
				kind: "tool_failure",
				toolName: truncateUtf8(failure.toolName, 200),
				...(failure.command
					? { command: truncateUtf8(failure.command, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) }
					: {}),
				...(result ? { result } : {}),
			});
		},
		flush() {
			if (flushPromise) return flushPromise;
			flushPromise = (async () => {
				if (records.length === 0) return undefined;
				const directoryPath = getReviewPrivateDiagnosticsDirectory(options.agentDir);
				ensurePrivateDirectorySync(directoryPath);
				const timestamp = createdAt.toISOString().replace(/[:.]/g, "-");
				const runHash = createHash("sha256").update(runId).digest("hex").slice(0, 16);
				const filePath = join(directoryPath, `${timestamp}_${runHash}.jsonl`);
				await writePrivateNewFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
				await prunePrivateDiagnosticFiles(directoryPath);
				return filePath;
			})();
			return flushPromise;
		},
	};
}
