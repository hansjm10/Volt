import { describe, expect, it } from "vitest";
import {
	decodeStoredSessionEntry,
	digestClientInputPayload,
	parsePersistedSessionEntry,
	parseSessionEntryForAdmission,
	parseSessionSnapshotHeader,
	sessionEntryEnvelope,
	validatePersistedSessionEntrySequence,
} from "../src/core/session-entry-codec.ts";
import { CURRENT_SESSION_SNAPSHOT_VERSION, CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";

const ENTRY_TIMESTAMP = "2026-09-03T12:00:00.000Z";
const MESSAGE_TIMESTAMP = Date.parse(ENTRY_TIMESTAMP);

function base(type: string, id: string, ordinal: number, parentId: string | null = null) {
	return { type, id, parentId, timestamp: ENTRY_TIMESTAMP, ordinal };
}

function validAssistantMessage() {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reason" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: MESSAGE_TIMESTAMP,
	};
}

function validEntries(): Array<Record<string, unknown>> {
	const input = { message: "queued", images: [] };
	return [
		{
			...base("message", "message", 1),
			message: { role: "user", content: "hello", timestamp: MESSAGE_TIMESTAMP },
		},
		{
			...base("client_input_receipt", "receipt", 2),
			clientMessageId: "client-1",
			command: "steer",
			semanticDigest: digestClientInputPayload("steer", input),
			input,
		},
		{
			...base("client_input_queued", "queued", 3),
			receiptId: "receipt",
			clientMessageId: "client-1",
			queuedInput: { delivery: "steer", message: "queued", images: [] },
		},
		{
			...base("client_input_state", "state", 4),
			receiptId: "receipt",
			clientMessageId: "client-1",
			state: "started",
		},
		{ ...base("thinking_level_change", "thinking", 5), thinkingLevel: "high" },
		{ ...base("fast_mode_change", "fast", 6), enabled: true },
		{ ...base("model_change", "model", 7), provider: "provider", modelId: "model" },
		{ ...base("planning_state_change", "planning", 8), planning: { mode: "plan", plan: null } },
		{
			...base("compaction", "compaction", 9, "message"),
			summary: "summary",
			firstKeptEntryId: "message",
			tokensBefore: 10,
		},
		{ ...base("branch_summary", "branch", 10), fromId: "root", summary: "branch summary" },
		{ ...base("custom", "custom", 11), customType: "extension", data: { value: true } },
		{
			...base("custom_message", "custom-message", 12),
			customType: "extension",
			content: [{ type: "text", text: "custom" }],
			display: true,
			details: { value: 1 },
		},
		{ ...base("label", "label", 13), targetId: "message", label: "bookmark" },
		{ ...base("session_info", "session-info", 14), name: "Session" },
		{ ...base("session_start_git_context", "git", 15), gitContext: null },
		{ ...base("leaf", "leaf", 16), targetId: "message" },
		{
			...base("subagent_spawn", "spawn", 17),
			toolCallId: "call-1",
			subagentId: "sa_child",
			agent: "researcher",
			childSessionId: "child-session",
			childSessionRef: {
				sessionDirectory: "/sessions/child",
				storeId: "store-child",
				sessionId: "child-session",
				sessionGeneration: "generation-child",
			},
			requestKey: "request-1",
		},
	];
}

const REQUIRED_TYPE_FIELD: Record<string, string> = {
	message: "message",
	client_input_receipt: "input",
	client_input_queued: "queuedInput",
	client_input_state: "state",
	thinking_level_change: "thinkingLevel",
	fast_mode_change: "enabled",
	model_change: "modelId",
	planning_state_change: "planning",
	compaction: "summary",
	branch_summary: "summary",
	custom: "customType",
	custom_message: "content",
	label: "targetId",
	session_info: "id",
	session_start_git_context: "gitContext",
	leaf: "targetId",
	subagent_spawn: "requestKey",
};

describe("session entry codec", () => {
	it("round-trips every canonical entry type and derives its envelope", () => {
		for (const value of validEntries()) {
			const parsed = parsePersistedSessionEntry(value);
			expect(parsed).toEqual(value);
			expect(sessionEntryEnvelope(parsed)).toEqual({
				id: value.id,
				parentId: value.parentId,
				type: value.type,
				timestamp: value.timestamp,
				ordinal: value.ordinal,
				isHostOnly: [
					"client_input_receipt",
					"client_input_queued",
					"client_input_state",
					"session_start_git_context",
					"leaf",
					"subagent_spawn",
				].includes(String(value.type)),
			});
		}
	});

	it("rejects unknown and missing fields for every entry type", () => {
		for (const value of validEntries()) {
			expect(() => parsePersistedSessionEntry({ ...value, unsupported: true })).toThrow("unknown property");
			const missing = structuredClone(value);
			delete missing[REQUIRED_TYPE_FIELD[String(value.type)]!];
			expect(() => parsePersistedSessionEntry(missing)).toThrow();
		}
	});

	it("validates every supported message role and rejects malformed nested content", () => {
		const messages = [
			{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 },
			validAssistantMessage(),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				details: { lines: 1 },
				isError: false,
				timestamp: 2,
			},
			{
				role: "bashExecution",
				command: "pwd",
				output: "/tmp",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 3,
			},
			{
				role: "custom",
				customType: "notice",
				content: "custom",
				display: false,
				details: { ok: true },
				timestamp: 4,
			},
		];
		for (const [index, message] of messages.entries()) {
			expect(
				parseSessionEntryForAdmission({
					type: "message",
					id: `message-${index}`,
					parentId: null,
					timestamp: ENTRY_TIMESTAMP,
					message,
				}),
			).toMatchObject({ message });
		}
		expect(() =>
			parseSessionEntryForAdmission({
				type: "message",
				id: "bad-message",
				parentId: null,
				timestamp: ENTRY_TIMESTAMP,
				message: { role: "user", content: [{ type: "video", data: "abc" }], timestamp: 1 },
			}),
		).toThrow("unsupported user content type");
		expect(() =>
			parseSessionEntryForAdmission({
				type: "message",
				id: "bad-tool-call",
				parentId: null,
				timestamp: ENTRY_TIMESTAMP,
				message: {
					...validAssistantMessage(),
					content: [{ type: "toolCall", id: "", name: "read", arguments: {} }],
				},
			}),
		).toThrow("must not be empty");
	});

	it("rejects noncanonical JSON, timestamps, numbers, and modes", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			parseSessionEntryForAdmission({
				type: "custom",
				id: "cyclic",
				parentId: null,
				timestamp: ENTRY_TIMESTAMP,
				customType: "test",
				data: cyclic,
			}),
		).toThrow("cyclic references are not permitted");
		expect(() => parsePersistedSessionEntry({ ...validEntries()[0], timestamp: "2026-09-03" })).toThrow(
			"canonical ISO-8601",
		);
		expect(() =>
			parsePersistedSessionEntry({
				...validEntries().find((entry) => entry.type === "compaction"),
				tokensBefore: NaN,
			}),
		).toThrow("numbers must be finite");
		expect(() =>
			parsePersistedSessionEntry({
				...validEntries().find((entry) => entry.type === "thinking_level_change"),
				thinkingLevel: "turbo",
			}),
		).toThrow("invalid thinking level");
		expect(() =>
			parsePersistedSessionEntry({
				...validEntries().find((entry) => entry.type === "planning_state_change"),
				planning: { mode: "ship", plan: null },
			}),
		).toThrow("planning.mode is invalid");
		const invalidImageInput = {
			message: "image",
			images: [{ type: "image" as const, mimeType: "", data: "abc" }],
		};
		expect(() =>
			parsePersistedSessionEntry({
				...validEntries().find((entry) => entry.type === "client_input_receipt"),
				semanticDigest: digestClientInputPayload("steer", invalidImageInput),
				input: invalidImageInput,
			}),
		).toThrow("must not be empty");
	});

	it.each(["id", "parentId", "type", "timestamp", "ordinal", "isHostOnly"] as const)(
		"rejects a %s SQL envelope mismatch",
		(field) => {
			const entry = parsePersistedSessionEntry(validEntries()[0]);
			const stored = { ...sessionEntryEnvelope(entry), payload: entry };
			const mismatches = {
				id: "other-id",
				parentId: "other-parent",
				type: "custom",
				timestamp: "2026-09-03T12:00:01.000Z",
				ordinal: 2,
				isHostOnly: true,
			};
			expect(() => decodeStoredSessionEntry({ ...stored, [field]: mismatches[field] })).toThrow(
				"does not match its canonical payload",
			);
		},
	);

	it("rejects duplicate identities, ordinal gaps, and invalid parent or target references", () => {
		const root = validEntries()[0];
		expect(() => validatePersistedSessionEntrySequence([root, { ...root, ordinal: 2 }])).toThrow(
			"duplicate identity",
		);
		expect(() => validatePersistedSessionEntrySequence([{ ...root, ordinal: 2 }])).toThrow("non-contiguous ordinal");
		expect(() =>
			validatePersistedSessionEntrySequence([
				{ ...root, parentId: "future" },
				{ ...root, id: "future", ordinal: 2 },
			]),
		).toThrow("invalid or forward parent");
		expect(() =>
			validatePersistedSessionEntrySequence([root, { ...base("label", "label", 2), targetId: "missing" }]),
		).toThrow("targets an invalid conversation entry");
		expect(() =>
			validatePersistedSessionEntrySequence([root, { ...base("leaf", "leaf", 2), targetId: "missing" }]),
		).toThrow("targets an invalid conversation entry");
	});

	it("rejects invalid client input references and transitions", () => {
		const queued = validEntries().find((entry) => entry.type === "client_input_queued")!;
		expect(() => validatePersistedSessionEntrySequence([{ ...queued, ordinal: 1 }])).toThrow(
			"has no matching receipt",
		);

		const receipt = { ...validEntries().find((entry) => entry.type === "client_input_receipt")!, ordinal: 1 };
		expect(() =>
			validatePersistedSessionEntrySequence([receipt, { ...receipt, id: "duplicate-receipt", ordinal: 2 }]),
		).toThrow("duplicate durable receipts");
		const queuedEntry = {
			...validEntries().find((entry) => entry.type === "client_input_queued")!,
			ordinal: 2,
		};
		expect(() =>
			validatePersistedSessionEntrySequence([
				receipt,
				queuedEntry,
				{ ...queuedEntry, id: "duplicate-queue", ordinal: 3 },
			]),
		).toThrow("duplicate queued entries");
		const started = {
			...validEntries().find((entry) => entry.type === "client_input_state")!,
			ordinal: 2,
			state: "started",
		};
		const repeated = { ...started, id: "state-again", ordinal: 3 };
		expect(() => validatePersistedSessionEntrySequence([receipt, started, repeated])).toThrow(
			"repeats the started boundary",
		);
		expect(() =>
			validatePersistedSessionEntrySequence([
				receipt,
				{
					...base("message", "identified-message", 2),
					message: {
						role: "user",
						content: "too early",
						clientMessageId: "client-1",
						timestamp: MESSAGE_TIMESTAMP,
					},
				},
			]),
		).toThrow("requires a started receipt");
	});

	it("rejects invalid compaction, branch, Git-context, and child-session relationships", () => {
		const root = validEntries()[0];
		const sibling = {
			...base("message", "sibling", 2),
			message: { role: "user", content: "sibling", timestamp: MESSAGE_TIMESTAMP },
		};
		expect(() =>
			validatePersistedSessionEntrySequence([
				root,
				sibling,
				{
					...base("compaction", "compaction", 3, "message"),
					summary: "summary",
					firstKeptEntryId: "sibling",
					tokensBefore: 1,
				},
			]),
		).toThrow("invalid first-kept boundary");
		expect(() =>
			validatePersistedSessionEntrySequence([
				root,
				{ ...base("branch_summary", "branch", 2, "message"), fromId: "root", summary: "summary" },
			]),
		).toThrow("invalid source");
		expect(() =>
			validatePersistedSessionEntrySequence([
				root,
				{ ...base("session_start_git_context", "git-1", 2), gitContext: null },
				{ ...base("session_start_git_context", "git-2", 3), gitContext: null },
			]),
		).toThrow("more than one starting Git context");
		expect(() =>
			parsePersistedSessionEntry({
				...validEntries().find((entry) => entry.type === "subagent_spawn"),
				childSessionId: "other-child",
			}),
		).toThrow("must match childSessionId");
	});

	it("validates strict snapshot headers", () => {
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
			id: "session-id",
			timestamp: ENTRY_TIMESTAMP,
			cwd: "/workspace",
		};
		expect(parseSessionSnapshotHeader(header, CURRENT_SESSION_VERSION, CURRENT_SESSION_SNAPSHOT_VERSION)).toEqual(
			header,
		);
		expect(() =>
			parseSessionSnapshotHeader(
				{ ...header, parentSessionId: "parent" },
				CURRENT_SESSION_VERSION,
				CURRENT_SESSION_SNAPSHOT_VERSION,
			),
		).toThrow("parent reference must be complete");
		expect(() =>
			parseSessionSnapshotHeader(
				{ ...header, unknown: true },
				CURRENT_SESSION_VERSION,
				CURRENT_SESSION_SNAPSHOT_VERSION,
			),
		).toThrow("unknown property");
	});
});
