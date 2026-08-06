import { constants as bufferConstants } from "buffer";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a newline-terminated malformed record as ambiguous durable state", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow("Current session JSONL is malformed at committed line 1");
	});

	it("rejects invalid UTF-8 in a committed current-schema record", () => {
		const file = join(tempDir, "invalid-utf8.jsonl");
		const header = Buffer.from(
			'{"type":"session","version":5,"id":"invalid-utf8","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		const invalidRecord = Buffer.concat([
			Buffer.from(
				'{"type":"message","id":"1","ordinal":1,"parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"',
			),
			Buffer.from([0x80]),
			Buffer.from('","timestamp":1}}\n'),
		]);
		writeFileSync(file, Buffer.concat([header, invalidRecord]));

		expect(() => loadEntriesFromFile(file)).toThrow("Current session JSONL is malformed at committed line 2");
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("rejects a future session schema without mutating its bytes", () => {
		const file = join(tempDir, "future-v6.jsonl");
		const content =
			'{"type":"session","version":6,"id":"future","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"client_input_receipt","id":"receipt","parentId":null,"timestamp":"2025-01-01T00:00:01Z","clientMessageId":"future-input","command":"prompt","semanticDigest":"unknown-v6-shape"}\n';
		writeFileSync(file, content);

		expect(() => SessionManager.open(file, tempDir)).toThrow("newer than supported version 5");
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("rejects a non-numeric session schema without mutating its bytes", () => {
		const file = join(tempDir, "string-v5.jsonl");
		const content =
			'{"type":"session","version":"5","id":"string-version","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
		writeFileSync(file, content);

		expect(() => SessionManager.open(file, tempDir)).toThrow("Session has an invalid schema version");
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("keeps legacy best-effort parsing for malformed interior lines", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});

	it("ignores a malformed unterminated final fragment as a torn append", () => {
		const file = join(tempDir, "torn-tail.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":5,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","ordinal":1,"parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n' +
				'{"type":"client_input_state"',
		);

		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[1]?.type).toBe("message");
	});

	it("rejects malformed committed bytes before an atomic append without rewriting them", async () => {
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendPlanningState({ mode: "build", plan: null });
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		appendFileSync(sessionFile, "not-json\n");
		const exactPreimage = readFileSync(sessionFile);

		await expect(
			manager.appendAtomically(
				() => manager.appendPlanningState({ mode: "build", plan: null }),
				() => {},
			),
		).rejects.toMatchObject({
			effect: "not_started",
			authority: "reconciliation_required",
			message: expect.stringContaining("malformed at committed line"),
		});
		expect(readFileSync(sessionFile).equals(exactPreimage)).toBe(true);
		const authority = manager.getConversationAuthorityStatus();
		expect(authority.status).toBe("reconciliation_required");
		expect(() => manager.getEntries()).toThrow(
			"Session conversation authority requires reconciliation because persisted state could not be proven",
		);
		await expect(manager.drainPersistence()).resolves.toMatchObject({
			status: "reconciliation_required",
		});
	});

	it("retains authority when a matching legacy schema prevents an atomic append", async () => {
		const sessionFile = join(tempDir, "legacy-atomic.jsonl");
		writeFileSync(
			sessionFile,
			'{"type":"session","version":3,"id":"legacy-atomic","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		const manager = SessionManager.open(sessionFile, tempDir);
		const exactPreimage = readFileSync(sessionFile);

		await expect(
			manager.appendAtomically(
				() => manager.appendPlanningState({ mode: "build", plan: null }),
				() => {},
			),
		).rejects.toMatchObject({
			effect: "not_started",
			authority: "available",
			message: "Atomic append requires the current session schema",
		});
		expect(readFileSync(sessionFile).equals(exactPreimage)).toBe(true);
		expect(manager.getConversationAuthorityStatus()).toEqual({ status: "available" });
	});

	it("atomically appends across valid and torn unterminated tails", async () => {
		const completeFile = join(tempDir, "atomic-complete-tail.jsonl");
		writeFileSync(
			completeFile,
			'{"type":"session","version":5,"id":"atomic-complete","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
		);
		const complete = SessionManager.open(completeFile, tempDir);
		await complete.appendAtomically(
			() => complete.appendPlanningState({ mode: "build", plan: null }),
			() => {},
		);
		expect(SessionManager.open(completeFile, tempDir).buildSessionContext().planning).toEqual({
			mode: "build",
			plan: null,
		});

		const tornFile = join(tempDir, "atomic-torn-tail.jsonl");
		writeFileSync(
			tornFile,
			'{"type":"session","version":5,"id":"atomic-torn","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"client_input_sta',
		);
		const torn = SessionManager.open(tornFile, tempDir);
		await torn.appendAtomically(
			() => torn.appendPlanningState({ mode: "build", plan: null }),
			() => {},
		);
		expect(readFileSync(tornFile, "utf8")).not.toContain("client_input_sta");
		expect(SessionManager.open(tornFile, tempDir).buildSessionContext().planning).toEqual({
			mode: "build",
			plan: null,
		});
	});

	it("durably normalizes complete and torn unterminated tails before appending", async () => {
		const completeFile = join(tempDir, "complete-tail.jsonl");
		writeFileSync(
			completeFile,
			'{"type":"session","version":5,"id":"complete-tail","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
		);
		const completeTailBeforeOpen = readFileSync(completeFile, "utf8");
		const complete = SessionManager.open(completeFile, tempDir);
		expect(readFileSync(completeFile, "utf8")).toBe(completeTailBeforeOpen);
		complete.reserveClientInput("after-complete-tail", "prompt", { message: "hello" });
		await complete.flush();
		expect(() => SessionManager.open(completeFile, tempDir)).not.toThrow();
		expect(readFileSync(completeFile, "utf8")).toContain('"clientMessageId":"after-complete-tail"');

		const tornFile = join(tempDir, "torn-repair.jsonl");
		writeFileSync(
			tornFile,
			'{"type":"session","version":5,"id":"torn-repair","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"client_input_sta',
		);
		const tornTailBeforeOpen = readFileSync(tornFile, "utf8");
		const repaired = SessionManager.open(tornFile, tempDir);
		expect(readFileSync(tornFile, "utf8")).toBe(tornTailBeforeOpen);
		repaired.reserveClientInput("after-torn-tail", "prompt", { message: "hello" });
		await repaired.flush();
		const reopened = SessionManager.open(tornFile, tempDir);
		expect(reopened.getClientInput("after-torn-tail")?.state).toBe("accepted");
		expect(readFileSync(tornFile, "utf8")).not.toContain('{"type":"client_input_sta\n');
	});

	it("opens session files larger than Node's max string length", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);

		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}

		appendFileSync(
			file,
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = SessionManager.open(file, tempDir);
		expect(sessionManager.getSessionId()).toBe("abc");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("discovers and resumes a valid header larger than the old 512-byte probe", async () => {
		const sessionId = "long-header";
		const file = join(tempDir, `2025-01-01T00-00-00-000Z_${sessionId}.jsonl`);
		const cwd = `/${["a".repeat(220), "b".repeat(220), "c".repeat(220)].join("/")}`;
		const header = `${JSON.stringify({
			type: "session",
			version: 5,
			id: sessionId,
			timestamp: "2025-01-01T00:00:00Z",
			cwd,
		})}\n`;
		expect(Buffer.byteLength(header, "utf8")).toBeGreaterThan(512);
		writeFileSync(file, header);

		expect(findMostRecentSession(tempDir)).toBe(file);
		await expect(SessionManager.findForResume(tempDir, sessionId)).resolves.toEqual({
			id: sessionId,
			path: file,
		});
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createPersistedSession(cwd: string, label: string): Promise<string> {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = await createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = await createPersistedSession(projectB, "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionFile()).toBe(sessionA);
	});
});

describe("SessionManager.setSessionFile with invalid files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects an empty existing file without rewriting it", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		expect(() => SessionManager.open(emptyFile, tempDir)).toThrow("no valid session header");
		expect(readFileSync(emptyFile, "utf8")).toBe("");
	});

	it("rejects a file without a session header without rewriting it", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const original =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, original);

		expect(() => SessionManager.open(noHeaderFile, tempDir)).toThrow("no valid session header");
		expect(readFileSync(noHeaderFile, "utf8")).toBe(original);
	});

	it("preserves an explicit nonexistent session path for a new session", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("does not destructively rewrite a fully malformed committed file", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		const original = "garbage content\n";
		writeFileSync(corruptedFile, original);

		expect(() => SessionManager.open(corruptedFile, tempDir)).toThrow(
			"Current session JSONL is malformed at committed line 1",
		);
		expect(readFileSync(corruptedFile, "utf8")).toBe(original);
	});
});
