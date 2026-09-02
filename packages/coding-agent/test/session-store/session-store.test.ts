import { type ChildProcess, execFileSync, fork } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireSharedSQLiteSessionStore,
	digestSessionStoreTransactionPayload,
	SESSION_STORE_BUSY_TIMEOUT_MS,
	SESSION_STORE_DATABASE_FILENAME,
	SESSION_STORE_SCHEMA_VERSION,
	type SessionStoreApplyTransactionInput,
	type SessionStoreCreateSessionInput,
	type SessionStoreInfo,
	type SessionStoreTransactionPayload,
	SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../src/core/session-store/index.ts";
import { SESSION_STORE_SCHEMA_SQL } from "../../src/core/session-store/schema.ts";
import type { OpenStoreChildRequest, OpenStoreChildResponse } from "./open-store-child.ts";

const CREATED_AT = "2026-08-31T12:00:00.000Z";
const UPDATED_AT = "2026-08-31T12:01:00.000Z";
const OPEN_STORE_CHILD_PATH = resolve(__dirname, "open-store-child.ts");
const OPEN_STORE_CHILD_COUNT = 8;
const OPEN_STORE_CHILD_TIMEOUT_MS = 10_000;

interface OpenStoreChildHandle {
	readonly child: ChildProcess;
	readonly stderr: () => string;
}

interface StoreSchemaState {
	readonly userVersion: number;
	readonly objectNames: readonly string[];
}

function generationFor(id: string): string {
	return `generation:${id}:1`;
}

const roots: string[] = [];
const clients: SQLiteSessionStoreClient[] = [];
const leases: SQLiteSessionStoreLease[] = [];
const openStoreChildren = new Set<OpenStoreChildHandle>();

function makeSessionDirectory(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-session-store-"));
	roots.push(root);
	return join(root, "sessions");
}

function createInput(id = "session-1", sessionGeneration = generationFor(id)): SessionStoreCreateSessionInput {
	return {
		id,
		sessionGeneration,
		formatVersion: 5,
		cwd: "/workspace/project",
		createdAt: CREATED_AT,
		parentSessionDirectory: null,
		parentStoreId: null,
		parentSessionId: null,
		parentSessionGeneration: null,
		origin: null,
	};
}

function emptyPayload(
	overrides: Partial<SessionStoreTransactionPayload["session"]> = {},
): SessionStoreTransactionPayload {
	return {
		session: {
			updatedAt: UPDATED_AT,
			startingGitContextRecorded: false,
			startingGitContext: null,
			name: null,
			visible: false,
			leafId: null,
			messageCount: 0,
			firstMessage: "",
			...overrides,
		},
		entries: [],
		labels: [],
		clientInputs: [],
		subagentSpawns: [],
		searchChunks: [],
	};
}

function transaction(
	sessionId: string,
	expectedRevision: number,
	commitId: string,
	payload: SessionStoreTransactionPayload,
): SessionStoreApplyTransactionInput {
	return {
		sessionId,
		sessionGeneration: generationFor(sessionId),
		expectedRevision,
		commitId,
		digest: digestSessionStoreTransactionPayload(payload),
		payload,
	};
}

async function openStore(sessionDirectory = makeSessionDirectory()): Promise<SQLiteSessionStoreClient> {
	const client = await SQLiteSessionStoreClient.open(sessionDirectory);
	clients.push(client);
	return client;
}

async function acquireStore(sessionDirectory = makeSessionDirectory()): Promise<SQLiteSessionStoreLease> {
	const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
	leases.push(lease);
	return lease;
}

function mutateStoreSchema(databasePath: string, sql: string): void {
	execFileSync(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			"-e",
			'const { DatabaseSync } = require("node:" + "sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec(process.argv[2]); db.close();',
			databasePath,
			sql,
		],
		{ stdio: "pipe" },
	);
}

function openStoreChildResponseKind(message: unknown): OpenStoreChildResponse["kind"] | undefined {
	if (!message || typeof message !== "object" || !("kind" in message)) return undefined;
	const kind = message.kind;
	if (kind === "ready" || kind === "opening" || kind === "opened" || kind === "error" || kind === "closed") {
		return kind;
	}
	return undefined;
}

function childFailureMessage(handle: OpenStoreChildHandle, description: string): string {
	const stderr = handle.stderr().trim();
	return stderr ? `${description}: ${stderr}` : description;
}

function waitForOpenStoreChildResponse(
	handle: OpenStoreChildHandle,
	acceptedKinds: readonly OpenStoreChildResponse["kind"][],
	description: string,
): Promise<OpenStoreChildResponse> {
	return new Promise((resolveResponse, rejectResponse) => {
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) clearTimeout(timeout);
			handle.child.off("message", onMessage);
			handle.child.off("error", onError);
			handle.child.off("exit", onExit);
		};
		const fail = (message: string): void => {
			cleanup();
			rejectResponse(new Error(childFailureMessage(handle, message)));
		};
		const onMessage = (message: unknown): void => {
			const kind = openStoreChildResponseKind(message);
			if (!kind || !acceptedKinds.includes(kind)) return;
			cleanup();
			resolveResponse(message as OpenStoreChildResponse);
		};
		const onError = (error: Error): void => fail(`${description} failed: ${error.message}`);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
			fail(`${description} exited early with code ${String(code)} and signal ${String(signal)}`);

		handle.child.on("message", onMessage);
		handle.child.once("error", onError);
		handle.child.once("exit", onExit);
		timeout = setTimeout(
			() => fail(`${description} exceeded ${OPEN_STORE_CHILD_TIMEOUT_MS}ms`),
			OPEN_STORE_CHILD_TIMEOUT_MS,
		);
	});
}

function waitForOpenStoreChildExit(
	handle: OpenStoreChildHandle,
	timeoutMs = OPEN_STORE_CHILD_TIMEOUT_MS,
): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit, rejectExit) => {
		const cleanup = (): void => {
			clearTimeout(timeout);
			handle.child.off("exit", onExit);
		};
		const onExit = (): void => {
			cleanup();
			resolveExit();
		};
		const timeout = setTimeout(() => {
			cleanup();
			rejectExit(new Error(childFailureMessage(handle, `Child exit exceeded ${timeoutMs}ms`)));
		}, timeoutMs);
		handle.child.once("exit", onExit);
	});
}

function spawnOpenStoreChild(): OpenStoreChildHandle {
	let stderr = "";
	const child = fork(OPEN_STORE_CHILD_PATH, [], {
		cwd: resolve(__dirname, "../.."),
		execArgv: ["--experimental-strip-types", "--conditions=volt-source", "--disable-warning=ExperimentalWarning"],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});
	const handle: OpenStoreChildHandle = { child, stderr: () => stderr };
	openStoreChildren.add(handle);
	child.once("exit", () => openStoreChildren.delete(handle));
	return handle;
}

function sendOpenStoreChildRequest(handle: OpenStoreChildHandle, request: OpenStoreChildRequest): void {
	if (!handle.child.connected) throw new Error("Session store child IPC channel is closed");
	handle.child.send(request);
}

function errorFromOpenStoreChild(response: Extract<OpenStoreChildResponse, { kind: "error" }>): Error {
	return new Error(`${response.code ? `${response.code}: ` : ""}${response.message}`);
}

async function terminateOpenStoreChild(handle: OpenStoreChildHandle): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
		openStoreChildren.delete(handle);
		return;
	}
	const exited = waitForOpenStoreChildExit(handle, 2_000).catch(() => undefined);
	handle.child.kill("SIGKILL");
	await exited;
	openStoreChildren.delete(handle);
}

async function closeOpenStoreChild(handle: OpenStoreChildHandle): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
	const responsePromise = waitForOpenStoreChildResponse(handle, ["closed", "error"], "Session store child close");
	const exitPromise = waitForOpenStoreChildExit(handle);
	sendOpenStoreChildRequest(handle, { kind: "close" });
	const response = await responsePromise;
	if (response.kind === "error") throw errorFromOpenStoreChild(response);
	await exitPromise;
}

async function openStoreInIndependentProcesses(
	sessionDirectory: string,
	afterOpening?: () => Promise<void>,
): Promise<SessionStoreInfo[]> {
	const handles: OpenStoreChildHandle[] = [];
	const readyPromises: Promise<OpenStoreChildResponse>[] = [];
	let closedCleanly = false;
	try {
		for (let index = 0; index < OPEN_STORE_CHILD_COUNT; index += 1) {
			const handle = spawnOpenStoreChild();
			handles.push(handle);
			readyPromises.push(waitForOpenStoreChildResponse(handle, ["ready"], "Session store child readiness"));
		}
		await Promise.all(readyPromises);

		const openingPromises = handles.map((handle) =>
			waitForOpenStoreChildResponse(handle, ["opening", "error"], "Session store child open start"),
		);
		const resultPromises = handles.map((handle) =>
			waitForOpenStoreChildResponse(handle, ["opened", "error"], "Session store child open result"),
		);
		for (const handle of handles) {
			sendOpenStoreChildRequest(handle, { kind: "open", sessionDirectory });
		}

		const openingResponses = await Promise.all(openingPromises);
		const openingFailure = openingResponses.find(
			(response): response is Extract<OpenStoreChildResponse, { kind: "error" }> => response.kind === "error",
		);
		if (openingFailure) throw errorFromOpenStoreChild(openingFailure);
		if (afterOpening) await afterOpening();

		const responses = await Promise.all(resultPromises);
		const failure = responses.find(
			(response): response is Extract<OpenStoreChildResponse, { kind: "error" }> => response.kind === "error",
		);
		if (failure) throw errorFromOpenStoreChild(failure);
		const infos = responses.map((response) => {
			if (response.kind !== "opened") throw new Error(`Unexpected child response ${response.kind}`);
			return response.info;
		});
		await Promise.all(handles.map((handle) => closeOpenStoreChild(handle)));
		closedCleanly = true;
		return infos;
	} finally {
		if (!closedCleanly) await Promise.all(handles.map((handle) => terminateOpenStoreChild(handle)));
	}
}

function readStoreSchemaState(databasePath: string): StoreSchemaState {
	const db = new DatabaseSync(databasePath);
	try {
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		if (typeof version !== "number") throw new Error("SQLite did not return user_version");
		const objectNames = db
			.prepare("SELECT name FROM main.sqlite_schema ORDER BY name")
			.all()
			.map((row) => {
				if (typeof row.name !== "string") throw new Error("SQLite returned an invalid schema object name");
				return row.name;
			});
		return { userVersion: version, objectNames };
	} finally {
		db.close();
	}
}

function seedUnversionedStore(sessionDirectory: string, sql: string): string {
	mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
	const databasePath = join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME);
	const db = new DatabaseSync(databasePath);
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
	return databasePath;
}

function assertConcurrentStoreInfos(infos: readonly SessionStoreInfo[], sessionDirectory: string): string {
	expect(infos).toHaveLength(OPEN_STORE_CHILD_COUNT);
	expect(new Set(infos.map((info) => info.storeId)).size).toBe(1);
	expect(new Set(infos.map((info) => info.databasePath))).toEqual(
		new Set([join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME)]),
	);
	return infos[0]!.storeId;
}

afterEach(async () => {
	await Promise.all([...openStoreChildren].map((handle) => terminateOpenStoreChild(handle)));
	await Promise.all(leases.splice(0).map((lease) => lease.release()));
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQLite session store", () => {
	it("initializes and reopens a versioned store with required SQLite settings", async () => {
		const sessionDirectory = makeSessionDirectory();
		const client = await openStore(sessionDirectory);

		expect(client.info).toMatchObject({
			databasePath: join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME),
			schemaVersion: SESSION_STORE_SCHEMA_VERSION,
			journalMode: "wal",
			foreignKeys: true,
			trustedSchema: false,
			busyTimeoutMs: SESSION_STORE_BUSY_TIMEOUT_MS,
		});
		expect(client.info.storeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
		expect(existsSync(client.info.databasePath)).toBe(true);
		const storeId = client.info.storeId;

		await client.close();
		clients.splice(clients.indexOf(client), 1);
		const reopened = await openStore(sessionDirectory);
		expect(reopened.info.storeId).toBe(storeId);
		expect(reopened.info.schemaVersion).toBe(SESSION_STORE_SCHEMA_VERSION);
		expect(await reopened.listSessionSummaries({ includeHidden: true })).toEqual([]);
	});

	it("initializes one missing database across independent processes", async () => {
		const sessionDirectory = makeSessionDirectory();
		mkdirSync(sessionDirectory, { mode: 0o700 });
		const infos = await openStoreInIndependentProcesses(sessionDirectory);
		const storeId = assertConcurrentStoreInfos(infos, sessionDirectory);

		const reopened = await openStore(sessionDirectory);
		expect(reopened.info.storeId).toBe(storeId);
	}, 30_000);

	it("serializes first schema initialization across independent processes", async () => {
		const sessionDirectory = makeSessionDirectory();
		const databasePath = seedUnversionedStore(sessionDirectory, "");
		const gate = new DatabaseSync(databasePath, { timeout: SESSION_STORE_BUSY_TIMEOUT_MS });
		let infos: SessionStoreInfo[];
		try {
			gate.exec(`PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS}`);
			const journalMode = gate.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
			expect(journalMode).toBe("wal");
			gate.exec("BEGIN IMMEDIATE");
			infos = await openStoreInIndependentProcesses(sessionDirectory, async () => {
				await delay(750);
				gate.exec("COMMIT");
			});
		} finally {
			if (gate.isTransaction) gate.exec("ROLLBACK");
			gate.close();
		}
		const storeId = assertConcurrentStoreInfos(infos, sessionDirectory);

		const reopened = await openStore(sessionDirectory);
		expect(reopened.info.storeId).toBe(storeId);
	}, 30_000);

	it("starts a store worker when the daemon process has V8 optimization arguments", async () => {
		const daemonFlag = "--optimize-for-size";
		process.execArgv.push(daemonFlag);
		try {
			const client = await openStore();
			expect(await client.listSessionSummaries({ includeHidden: true })).toEqual([]);
		} finally {
			const addedFlagIndex = process.execArgv.lastIndexOf(daemonFlag);
			if (addedFlagIndex >= 0) process.execArgv.splice(addedFlagIndex, 1);
		}
	});

	it("shares concurrent leases until the idempotent final release and supports fresh reacquisition", async () => {
		const sessionDirectory = makeSessionDirectory();
		const [first, same] = await Promise.all([
			acquireStore(sessionDirectory),
			acquireStore(resolve(sessionDirectory, ".")),
		]);
		expect(same.client).toBe(first.client);
		const close = vi.spyOn(first.client, "close");
		const storeId = first.client.info.storeId;

		await first.release();
		await first.release();
		expect(close).not.toHaveBeenCalled();
		expect(await same.client.listSessionSummaries({ includeHidden: true })).toEqual([]);

		await same.release();
		expect(close).toHaveBeenCalledOnce();
		const replacement = await acquireStore(sessionDirectory);
		expect(replacement.client).not.toBe(first.client);
		expect(replacement.client.info.storeId).toBe(storeId);
	});

	it("isolates failed initialization from a later lease generation", async () => {
		const sessionDirectory = makeSessionDirectory();
		writeFileSync(sessionDirectory, "not a directory", { mode: 0o600 });
		await expect(acquireSharedSQLiteSessionStore(sessionDirectory)).rejects.toBeInstanceOf(Error);
		rmSync(sessionDirectory);

		const replacement = await acquireStore(sessionDirectory);
		expect(replacement.client.info.databasePath).toBe(join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME));
	});

	it("replaces a failed pooled client without letting its release close the new generation", async () => {
		const sessionDirectory = makeSessionDirectory();
		const failed = await acquireStore(sessionDirectory);
		const worker = (failed.client as unknown as { worker: { terminate(): Promise<number> } }).worker;
		await worker.terminate();
		await vi.waitFor(async () => {
			await expect(failed.client.listSessionSummaries()).rejects.toMatchObject({ code: "closed" });
		});

		const replacement = await acquireStore(sessionDirectory);
		expect(replacement.client).not.toBe(failed.client);
		await failed.release();
		expect(await replacement.client.listSessionSummaries({ includeHidden: true })).toEqual([]);
	});

	it("permits immediate directory deletion after the final release", async () => {
		const sessionDirectory = makeSessionDirectory();
		const root = roots.at(-1)!;
		const lease = await acquireStore(sessionDirectory);
		await lease.release();

		rmSync(root, { recursive: true });
		roots.splice(roots.indexOf(root), 1);
		expect(existsSync(root)).toBe(false);
	});

	it("creates hidden sessions and loads indexed transaction state", async () => {
		const client = await openStore();
		const hidden = await client.createHiddenSession(createInput());
		expect(hidden).toMatchObject({
			id: "session-1",
			parentStoreId: null,
			visible: false,
			revision: 0,
			startingGitContextRecorded: false,
			startingGitContext: null,
		});
		expect(await client.listSessionSummaries()).toEqual([]);
		expect((await client.listSessionSummaries({ includeHidden: true })).map((session) => session.id)).toEqual([
			"session-1",
		]);

		const payload: SessionStoreTransactionPayload = {
			session: {
				updatedAt: UPDATED_AT,
				startingGitContextRecorded: true,
				startingGitContext: { branch: "main", commit: "abcdef", isDirty: false },
				name: "Foundation",
				visible: true,
				leafId: "message-1",
				messageCount: 1,
				firstMessage: "hello sqlite",
			},
			entries: [
				{
					id: "receipt-1",
					parentId: null,
					type: "client_input_receipt",
					timestamp: CREATED_AT,
					isHostOnly: true,
					payload: { input: { message: "hello sqlite" }, command: "prompt" },
				},
				{
					id: "message-1",
					parentId: null,
					type: "message",
					timestamp: UPDATED_AT,
					isHostOnly: false,
					payload: { message: { role: "user", content: "hello sqlite" } },
				},
				{
					id: "spawn-1",
					parentId: null,
					type: "subagent_spawn",
					timestamp: UPDATED_AT,
					isHostOnly: true,
					payload: { agent: "general-purpose" },
				},
			],
			labels: [{ targetEntryId: "message-1", label: "start", timestamp: UPDATED_AT }],
			clientInputs: [
				{
					clientMessageId: "client-1",
					receiptEntryId: "receipt-1",
					command: "prompt",
					semanticDigest: "semantic:1",
					input: { message: "hello sqlite", images: [] },
					queuedEntryId: null,
					queuedInput: null,
					state: "completed",
					error: null,
					canonicalEntryId: "message-1",
				},
			],
			subagentSpawns: [
				{
					entryId: "spawn-1",
					toolCallId: "tool-1",
					subagentId: "subagent-1",
					agent: "general-purpose",
					childSessionId: "child-1",
					childStoreId: "child-store-1",
					requestKey: "request-1",
				},
			],
			searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "hello sqlite" }],
		};
		const result = await client.applyTransaction(transaction("session-1", 0, "commit-1", payload));
		expect(result.status).toBe("committed");

		const listed = await client.listSessionSummaries();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: "session-1",
			name: "Foundation",
			revision: 1,
			messageCount: 1,
			startingGitContextRecorded: true,
			startingGitContext: { branch: "main", commit: "abcdef", isDirty: false },
		});
		expect(listed[0]).not.toHaveProperty("allMessagesText");
		expect(await client.findSessionSummary("session-1", generationFor("session-1"))).toEqual(listed[0]);

		const snapshot = await client.loadSession("session-1", generationFor("session-1"));
		expect(snapshot?.entries.map((entry) => [entry.id, entry.ordinal])).toEqual([
			["receipt-1", 1],
			["message-1", 2],
			["spawn-1", 3],
		]);
		expect(snapshot?.entries[1]?.payload).toEqual({ message: { content: "hello sqlite", role: "user" } });
		expect(snapshot?.labels).toEqual([{ targetEntryId: "message-1", label: "start", timestamp: UPDATED_AT }]);
		expect(snapshot?.clientInputs[0]).toMatchObject({ clientMessageId: "client-1", state: "completed" });
		expect(snapshot?.subagentSpawns[0]).toMatchObject({
			requestKey: "request-1",
			childSessionId: "child-1",
			childStoreId: "child-store-1",
		});
		expect(snapshot?.searchChunks).toEqual([{ chunkIndex: 0, entryId: "message-1", text: "hello sqlite" }]);
	});

	it("rejects write-time foreign-key violations and rolls back the transaction", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput());
		const payload: SessionStoreTransactionPayload = {
			...emptyPayload(),
			entries: [
				{
					id: "orphan-child",
					parentId: "missing-parent",
					type: "message",
					timestamp: UPDATED_AT,
					isHostOnly: false,
					payload: { type: "message" },
				},
			],
		};

		await expect(
			client.applyTransaction(transaction("session-1", 0, "invalid-parent", payload)),
		).rejects.toMatchObject({ code: "constraint_failed" });
		expect(await client.findSessionSummary("session-1", generationFor("session-1"))).toMatchObject({
			revision: 0,
			leafId: null,
		});
		expect((await client.loadSession("session-1", generationFor("session-1")))?.entries).toEqual([]);
		expect(await client.verifyForeignKeys()).toEqual({ status: "valid" });
	});

	it("persists cross-store parent identity", async () => {
		const client = await openStore();
		const child = await client.createHiddenSession({
			...createInput("child-session"),
			parentSessionDirectory: "/other/sessions",
			parentStoreId: client.info.storeId,
			parentSessionId: "parent-session",
			parentSessionGeneration: "parent-generation",
			origin: "subagent",
		});
		expect(child).toMatchObject({
			parentSessionDirectory: "/other/sessions",
			parentStoreId: client.info.storeId,
			parentSessionId: "parent-session",
			parentSessionGeneration: "parent-generation",
			origin: "subagent",
		});
	});

	it("searches extracted chunks with token, phrase, regex, and fuzzy matching", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput("matching"));
		await client.createHiddenSession(createInput("other"));
		const matchingPayload = {
			...emptyPayload({ visible: true, name: "Matching session" }),
			searchChunks: [
				{ chunkIndex: 0, entryId: null, text: "hello" },
				{ chunkIndex: 1, entryId: null, text: "sqlite" },
			],
		};
		const otherPayload = {
			...emptyPayload({ visible: true, name: "Other session" }),
			searchChunks: [{ chunkIndex: 0, entryId: null, text: "unrelated content" }],
		};
		await client.applyTransaction(transaction("matching", 0, "commit-matching", matchingPayload));
		await client.applyTransaction(transaction("other", 0, "commit-other", otherPayload));

		const ids = async (query: string): Promise<string[]> =>
			(await client.searchSessionSummaries(query)).map(({ summary }) => summary.id);
		expect(await ids('"hello sqlite"')).toEqual(["matching"]);
		expect(await ids("hellosqlite")).toEqual(["matching"]);
		expect(await ids("re:hello\\s+sqlite")).toEqual(["matching"]);
		expect(await ids("hello absent")).toEqual([]);
		expect(await ids("re:[")).toEqual([]);
	});

	it("ranks deep-text matches by score and modified-date ties", async () => {
		const client = await openStore();
		const addMatch = async (id: string, updatedAt: string, text: string): Promise<void> => {
			await client.createHiddenSession(createInput(id));
			const payload = {
				...emptyPayload({ updatedAt, visible: true, firstMessage: "summary only" }),
				searchChunks: [{ chunkIndex: 0, entryId: null, text }],
			};
			await client.applyTransaction(transaction(id, 0, `commit-${id}`, payload));
		};

		await addMatch("rank-old", "2026-08-31T12:02:00.000Z", "rankneedle tail");
		await addMatch("rank-new", "2026-08-31T12:04:00.000Z", "xxxx rankneedle");
		await addMatch("tie-old", "2026-08-31T12:03:00.000Z", "tieneedle");
		await addMatch("tie-new", "2026-08-31T12:05:00.000Z", "tieneedle");

		const ranked = await client.searchSessionSummaries('"rankneedle"');
		expect(ranked.map(({ summary }) => summary.id)).toEqual(["rank-old", "rank-new"]);
		expect(ranked[0]!.score).toBeLessThan(ranked[1]!.score);
		expect(ranked.every(({ score }) => Number.isFinite(score))).toBe(true);

		const tied = await client.searchSessionSummaries('"tieneedle"');
		expect(tied.map(({ summary }) => summary.id)).toEqual(["tie-new", "tie-old"]);
		expect(tied[0]!.score).toBe(tied[1]!.score);
	});

	it("rejects stale revisions without changing session state", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput());
		const firstPayload = emptyPayload({ name: "winner" });
		await client.applyTransaction(transaction("session-1", 0, "commit-winner", firstPayload));

		const stalePayload = emptyPayload({ name: "stale", updatedAt: "2026-08-31T12:02:00.000Z" });
		const conflict = await client.applyTransaction(transaction("session-1", 0, "commit-stale", stalePayload));
		expect(conflict).toEqual({ status: "conflict", actualRevision: 1 });
		expect(await client.findSessionSummary("session-1", generationFor("session-1"))).toMatchObject({
			revision: 1,
			name: "winner",
		});
	});

	it("isolates stale operations after deleting and recreating a session id", async () => {
		const sessionDirectory = makeSessionDirectory();
		const staleClient = await openStore(sessionDirectory);
		const replacingClient = await openStore(sessionDirectory);
		const sessionId = "reused-session";
		const staleGeneration = generationFor(sessionId);
		const replacementGeneration = "generation:reused-session:2";

		await staleClient.createHiddenSession(createInput(sessionId, staleGeneration));
		const staleRequest = transaction(sessionId, 0, "old-commit", emptyPayload({ name: "old" }));
		expect((await staleClient.applyTransaction(staleRequest)).status).toBe("committed");
		expect(
			await replacingClient.deleteSession({
				sessionId,
				sessionGeneration: staleGeneration,
				expectedRevision: 1,
			}),
		).toEqual({ status: "deleted" });
		await replacingClient.createHiddenSession(createInput(sessionId, replacementGeneration));

		expect(await staleClient.findSessionSummary(sessionId, staleGeneration)).toBeNull();
		expect(await staleClient.loadSession(sessionId, staleGeneration)).toBeNull();
		await expect(staleClient.applyTransaction(staleRequest)).rejects.toMatchObject({ code: "session_not_found" });
		expect(
			await staleClient.reconcileCommit({
				sessionId,
				sessionGeneration: staleGeneration,
				commitId: staleRequest.commitId,
				digest: staleRequest.digest,
			}),
		).toEqual({ status: "not_found" });
		expect(
			await staleClient.deleteSession({
				sessionId,
				sessionGeneration: staleGeneration,
				expectedRevision: 1,
			}),
		).toEqual({ status: "not_found" });
		expect(await replacingClient.findSessionSummary(sessionId, replacementGeneration)).toMatchObject({
			sessionGeneration: replacementGeneration,
			revision: 0,
		});
	});

	it("returns a conflict instead of deleting a newer revision", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput());
		await client.applyTransaction(transaction("session-1", 0, "commit-before-delete", emptyPayload()));

		expect(
			await client.deleteSession({
				sessionId: "session-1",
				sessionGeneration: generationFor("session-1"),
				expectedRevision: 0,
			}),
		).toEqual({ status: "conflict", actualRevision: 1 });
		expect(await client.findSessionSummary("session-1", generationFor("session-1"))).toMatchObject({
			revision: 1,
		});
	});

	it("loads every projection from one coherent snapshot during concurrent commits", async () => {
		const sessionDirectory = makeSessionDirectory();
		const reader = await openStore(sessionDirectory);
		const writer = await openStore(sessionDirectory);
		const sessionId = "snapshot-session";
		const sessionGeneration = generationFor(sessionId);
		await writer.createHiddenSession(createInput(sessionId));

		let writerFinished = false;
		const writeTransactions = (async () => {
			try {
				for (let revision = 0; revision < 40; revision += 1) {
					const entryId = `entry-${revision + 1}`;
					const payload: SessionStoreTransactionPayload = {
						...emptyPayload({
							visible: true,
							leafId: entryId,
							messageCount: revision + 1,
							firstMessage: "snapshot",
						}),
						entries: [
							{
								id: entryId,
								parentId: null,
								type: "message",
								timestamp: UPDATED_AT,
								isHostOnly: false,
								payload: { revision: revision + 1 },
							},
						],
						searchChunks: [{ chunkIndex: revision, entryId, text: entryId }],
					};
					const result = await writer.applyTransaction(
						transaction(sessionId, revision, `snapshot-commit-${revision + 1}`, payload),
					);
					expect(result.status).toBe("committed");
				}
			} finally {
				writerFinished = true;
			}
		})();
		const readSnapshots = (async () => {
			do {
				const snapshot = await reader.loadSession(sessionId, sessionGeneration);
				expect(snapshot).not.toBeNull();
				if (!snapshot) continue;
				expect(snapshot.entries).toHaveLength(snapshot.session.revision);
				expect(snapshot.searchChunks).toHaveLength(snapshot.session.revision);
				expect(snapshot.session.messageCount).toBe(snapshot.session.revision);
			} while (!writerFinished);
		})();
		await Promise.all([writeTransactions, readSnapshots]);
	});

	it("returns durable commit evidence and reconciles idempotent retries", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput());
		const payload = emptyPayload();
		const request = transaction("session-1", 0, "commit-evidence", payload);
		const committed = await client.applyTransaction(request);
		if (committed.status !== "committed") throw new Error("Expected committed transaction");

		const retry = await client.applyTransaction(request);
		expect(retry).toEqual(committed);
		expect(
			await client.reconcileCommit({
				sessionId: "session-1",
				sessionGeneration: generationFor("session-1"),
				commitId: "commit-evidence",
				digest: request.digest,
			}),
		).toEqual({ status: "committed", evidence: committed.evidence });

		const otherDigest = digestSessionStoreTransactionPayload(emptyPayload({ updatedAt: "2026-08-31T12:03:00.000Z" }));
		expect(
			await client.reconcileCommit({
				sessionId: "session-1",
				sessionGeneration: generationFor("session-1"),
				commitId: "commit-evidence",
				digest: otherDigest,
			}),
		).toEqual({ status: "mismatch" });
		expect(
			await client.reconcileCommit({
				sessionId: "session-1",
				sessionGeneration: generationFor("session-1"),
				commitId: "missing",
				digest: request.digest,
			}),
		).toEqual({ status: "not_found" });
	});

	it("deletes sessions and their transaction evidence", async () => {
		const client = await openStore();
		await client.createHiddenSession(createInput());
		const request = transaction("session-1", 0, "commit-delete", emptyPayload());
		await client.applyTransaction(request);

		const deleteInput = {
			sessionId: "session-1",
			sessionGeneration: generationFor("session-1"),
			expectedRevision: 1,
		};
		expect(await client.deleteSession(deleteInput)).toEqual({ status: "deleted" });
		expect(await client.findSessionSummary("session-1", generationFor("session-1"))).toBeNull();
		expect(await client.loadSession("session-1", generationFor("session-1"))).toBeNull();
		expect(await client.deleteSession(deleteInput)).toEqual({ status: "not_found" });
		expect(
			await client.reconcileCommit({
				sessionId: "session-1",
				sessionGeneration: generationFor("session-1"),
				commitId: "commit-delete",
				digest: request.digest,
			}),
		).toEqual({ status: "not_found" });
	});

	it.each([
		["a user table", "CREATE TABLE unexpected_table (id INTEGER PRIMARY KEY);"],
		["a view-only schema", "CREATE VIEW unexpected_view AS SELECT 1 AS value;"],
		[
			"residual internal schema state",
			"CREATE TABLE discarded_table (id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE discarded_table;",
		],
	])("rejects an unversioned store with %s without mutating its schema", async (_description, sql) => {
		const sessionDirectory = makeSessionDirectory();
		const databasePath = seedUnversionedStore(sessionDirectory, sql);
		const before = readStoreSchemaState(databasePath);
		expect(before.userVersion).toBe(0);
		expect(before.objectNames.length).toBeGreaterThan(0);

		await expect(SQLiteSessionStoreClient.open(sessionDirectory)).rejects.toMatchObject({
			code: "store_schema_mismatch",
		});

		expect(readStoreSchemaState(databasePath)).toEqual(before);
	});

	it.runIf(process.platform !== "win32")(
		"rejects dangling-symlink and hard-link database paths without replacing their referents",
		async () => {
			const sessionDirectory = makeSessionDirectory();
			mkdirSync(sessionDirectory, { mode: 0o700 });
			const databasePath = join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME);
			symlinkSync("missing.sqlite", databasePath);

			await expect(SQLiteSessionStoreClient.open(sessionDirectory)).rejects.toThrow("non-regular private file");
			expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);

			rmSync(databasePath);
			const referentPath = join(sessionDirectory, "referent.sqlite");
			writeFileSync(referentPath, "unchanged", { mode: 0o600 });
			linkSync(referentPath, databasePath);

			await expect(SQLiteSessionStoreClient.open(sessionDirectory)).rejects.toThrow("multiply-linked private file");
			expect(readFileSync(referentPath, "utf8")).toBe("unchanged");
			expect(statSync(referentPath).nlink).toBe(2);
		},
	);

	it.each([
		[
			"unexpected triggers",
			"CREATE TRIGGER unexpected_session_trigger AFTER UPDATE ON sessions BEGIN SELECT 1; END;",
		],
		["weakened table DDL", "weakened-schema"],
		[
			"a mismatched stored schema digest",
			`UPDATE store_metadata
			SET value_json = '"sha256:0000000000000000000000000000000000000000000000000000000000000000"'
			WHERE key = 'schema_digest';`,
		],
	])("rejects %s", async (_description, mutation) => {
		const sessionDirectory = makeSessionDirectory();
		const client = await openStore(sessionDirectory);
		const databasePath = client.info.databasePath;
		await client.close();
		clients.splice(clients.indexOf(client), 1);
		if (mutation === "weakened-schema") {
			for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				rmSync(path, { force: true });
			}
			const weakenedSchema = SESSION_STORE_SCHEMA_SQL.replace(
				"format_version INTEGER NOT NULL CHECK (format_version >= 1)",
				"format_version INTEGER NOT NULL CHECK (format_version >= 0)",
			);
			mutateStoreSchema(databasePath, `${weakenedSchema}\nPRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION};`);
		} else {
			mutateStoreSchema(databasePath, mutation);
		}

		await expect(SQLiteSessionStoreClient.open(sessionDirectory)).rejects.toMatchObject({
			code: "store_schema_mismatch",
		});
	});

	it.runIf(process.platform !== "win32")("uses owner-only directory and database permissions", async () => {
		const sessionDirectory = makeSessionDirectory();
		mkdirSync(sessionDirectory, { mode: 0o777 });
		chmodSync(sessionDirectory, 0o777);
		const client = await openStore(sessionDirectory);
		await client.close();
		clients.splice(clients.indexOf(client), 1);

		expect(statSync(sessionDirectory).mode & 0o777).toBe(0o700);
		expect(statSync(join(sessionDirectory, SESSION_STORE_DATABASE_FILENAME)).mode & 0o777).toBe(0o600);
	});
});
