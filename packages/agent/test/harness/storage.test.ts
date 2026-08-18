import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "../../src/harness/session/jsonl-storage.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import {
	err,
	FileError,
	type MessageEntry,
	ok,
	type SessionMetadata,
	type SessionMutation,
	type SessionStorage,
} from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

async function commitMutations(
	storage: Pick<SessionStorage, "commitBatch" | "getBranchSnapshot">,
	mutations: readonly SessionMutation[],
): Promise<readonly string[]> {
	const snapshot = await storage.getBranchSnapshot();
	const result = await storage.commitBatch({ guard: { kind: "exact", cursor: snapshot.cursor }, mutations });
	if (result.outcome !== "committed") throw result.error;
	return result.record.appendedEntryIds;
}

describe("InMemorySessionStorage", () => {
	it("returns configured session metadata", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata });
		expect(await storage.getMetadata()).toEqual(metadata);
	});

	it("copies initial entries and persists leaf changes", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const initialEntries = [entry];
		const storage = new InMemorySessionStorage({ entries: initialEntries });
		initialEntries.push({ ...entry, id: "entry-2" });
		expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual(["entry-1"]);
		expect(await storage.getLeafId()).toBe("entry-1");
		await commitMutations(storage, [{ kind: "move", leafId: null }]);
		expect(await storage.getLeafId()).toBeNull();
		expect((await storage.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: null });
	});

	it("rejects invalid leaf ids", async () => {
		const storage = new InMemorySessionStorage();
		await expect(commitMutations(storage, [{ kind: "move", leafId: "missing" }])).rejects.toThrow(
			"Entry missing not found",
		);
	});

	it("finds entries by type", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await commitMutations(storage, [
			{ kind: "append", entry: { type: "label", targetId: "entry-1", label: "checkpoint" } },
		]);
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await commitMutations(storage, [{ kind: "append", entry: { type: "label", targetId: "entry-1" } }]);
		expect(await storage.getLabel("entry-1")).toBeUndefined();
	});

	it("walks paths to root", async () => {
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		const storage = new InMemorySessionStorage({ entries: [root, child] });
		expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
		expect(await storage.getPathToRoot(null)).toEqual([]);
	});
});

describe("JsonlSessionStorage", () => {
	it("retires canonical authority after an ambiguous batch append failure", async () => {
		let content = "";
		let failAppend = false;
		const fs = {
			readTextFile: async () => ok<string, FileError>(content),
			readTextLines: async () => ok<string[], FileError>(content.split("\n")),
			writeFile: async (_path: string, value: string | Uint8Array) => {
				content = typeof value === "string" ? value : new TextDecoder().decode(value);
				return ok<void, FileError>(undefined);
			},
			appendFile: async (_path: string, value: string | Uint8Array) => {
				content += typeof value === "string" ? value : new TextDecoder().decode(value);
				return failAppend
					? err<void, FileError>(new FileError("unknown", "append completion was ambiguous"))
					: ok<void, FileError>(undefined);
			},
		};
		const storage = await JsonlSessionStorage.create(fs, "/session.jsonl", {
			cwd: "/workspace",
			sessionId: "session-1",
		});
		const snapshot = await storage.getBranchSnapshot();
		failAppend = true;
		const result = await storage.commitBatch({
			guard: { kind: "exact", cursor: snapshot.cursor },
			mutations: [{ kind: "append", entry: { type: "message", message: createUserMessage("one") } }],
		});
		expect(result).toMatchObject({ outcome: "uncertain", error: { code: "authority_retired" } });
		expect(await storage.getEntries()).toEqual([]);
		expect(content.trim().split("\n")).toHaveLength(2);
		await expect(storage.getBranchSnapshot()).rejects.toMatchObject({ code: "authority_retired" });
	});

	it("throws for missing files when opening", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "not_found" });
	});

	it("writes the header on create", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(await storage.getLeafId()).toBeNull();
		expect(await storage.getEntries()).toEqual([]);
		await commitMutations(storage, [
			{ kind: "append", entry: { type: "message", message: createUserMessage("one") } },
		]);
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[1]!).type).toBe("message");
		expect(lines).toHaveLength(2);
	});

	it("throws for malformed session headers", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "not json\n");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("first line is not a valid session header");
	});

	it("throws for malformed entry lines", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		writeFileSync(filePath, `${JSON.stringify(header)}\nnot json\n${JSON.stringify(entry)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("creates and reads session metadata from the header", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			parentSessionPath: "/tmp/parent.jsonl",
		});
		const metadata = await storage.getMetadata();
		expect(metadata).toMatchObject({
			id: "session-1",
			cwd: dir,
			path: filePath,
			parentSessionPath: "/tmp/parent.jsonl",
		});
		await commitMutations(storage, [
			{ kind: "append", entry: { type: "message", message: createUserMessage("one") } },
		]);
		expect(await loadJsonlSessionMetadata(env, filePath)).toEqual(metadata);
	});

	it("loads existing entries and reconstructs leaf", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		await storage.appendImportedEntry(root);
		await storage.appendImportedEntry(child);
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLeafId()).toBe("child");
		expect((await loaded.getEntries()).map((entry) => entry.id)).toEqual(["root", "child"]);
		await commitMutations(loaded, [{ kind: "move", leafId: "root" }]);
		const reloaded = await JsonlSessionStorage.open(env, filePath);
		expect(await reloaded.getLeafId()).toBe("root");
		expect((await reloaded.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: "root" });
		expect((await loaded.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("finds entries by type", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const [entryId] = await commitMutations(storage, [
			{ kind: "append", entry: { type: "message", message: createUserMessage("one") } },
		]);
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual([entryId]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const [entryId] = await commitMutations(storage, [
			{ kind: "append", entry: { type: "message", message: createUserMessage("one") } },
		]);
		if (!entryId) throw new Error("Expected committed message identity");
		expect(await storage.getLabel(entryId)).toBeUndefined();
		await commitMutations(storage, [
			{ kind: "append", entry: { type: "label", targetId: entryId, label: "checkpoint" } },
		]);
		expect(await storage.getLabel(entryId)).toBe("checkpoint");
		await commitMutations(storage, [{ kind: "append", entry: { type: "label", targetId: entryId } }]);
		expect(await storage.getLabel(entryId)).toBeUndefined();
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLabel(entryId)).toBeUndefined();
	});

	it("reads session metadata through the line-reading filesystem operation", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const metadata = await loadJsonlSessionMetadata(
			{
				readTextLines: async () => ok([JSON.stringify(header)]),
				readTextFile: async () => {
					throw new Error("readTextFile should not be called for metadata");
				},
				writeFile: async () => ok(undefined),
				appendFile: async () => ok(undefined),
			},
			filePath,
		);
		expect(metadata).toEqual({
			id: "session-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			cwd: dir,
			path: filePath,
		});
	});
});
