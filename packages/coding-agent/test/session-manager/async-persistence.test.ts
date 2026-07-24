import type { PathLike } from "node:fs";
import {
	existsSync,
	linkSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

interface IoEvent {
	kind: "open" | "write" | "sync";
	path: string;
	content?: string;
}

const io = vi.hoisted(() => ({
	events: [] as IoEvent[],
	beforeWrite: undefined as ((path: string, content: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("node:fs/promises");
	const actualOpen = actual.open as (
		path: PathLike,
		flags: string | number,
		mode?: number | string,
	) => Promise<FileHandle>;
	return {
		...actual,
		open: async (path: PathLike, flags: string | number, mode?: number | string): Promise<FileHandle> => {
			const filePath = String(path);
			io.events.push({ kind: "open", path: filePath });
			const handle = await actualOpen(path, flags, mode);
			return new Proxy(handle, {
				get(target, property) {
					if (property === "write") {
						return async (
							data: string | Uint8Array,
							positionOrOffset?: number,
							encodingOrLength?: BufferEncoding | number,
							position?: number,
						) => {
							const content = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
							io.events.push({ kind: "write", path: filePath, content });
							await io.beforeWrite?.(filePath, content);
							if (typeof data === "string") {
								return target.write(data, positionOrOffset, encodingOrLength as BufferEncoding);
							}
							return target.write(data, positionOrOffset, encodingOrLength as number, position);
						};
					}
					if (property === "writeFile") {
						return async (data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> => {
							const content = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
							io.events.push({ kind: "write", path: filePath, content });
							await io.beforeWrite?.(filePath, content);
							await target.writeFile(data, encoding);
						};
					}
					if (property === "sync") {
						return async (): Promise<void> => {
							io.events.push({ kind: "sync", path: filePath });
							await target.sync();
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as FileHandle;
		},
	};
});

const cleanups: string[] = [];

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-async-session-"));
	cleanups.push(root);
	return root;
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
	io.events.length = 0;
	io.beforeWrite = undefined;
	for (const path of cleanups.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("SessionManager asynchronous persistence", () => {
	it("returns before filesystem work and preserves observer, ordinal, and JSONL commit order", async () => {
		const root = createTempDir();
		const manager = SessionManager.create(root, root);
		const filePath = manager.getSessionFile()!;
		let releaseWrite!: () => void;
		let markWriteEntered!: () => void;
		const writeEntered = new Promise<void>((resolve) => {
			markWriteEntered = resolve;
		});
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		io.beforeWrite = async (path) => {
			if (path !== filePath) return;
			markWriteEntered();
			await writeGate;
		};
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));

		const first = manager.appendCustomMessageEntry("test", "one", true);
		const second = manager.appendCustomEntry("test", { value: "two" });
		const third = manager.appendSessionInfo("three");
		const watermark = manager.flush();

		expect(manager.flush()).toBe(watermark);
		expect(observed).toEqual([first, second, third]);
		expect(existsSync(filePath)).toBe(false);
		await writeEntered;
		expect(existsSync(filePath)).toBe(true);
		releaseWrite();
		await watermark;

		const entries = readJsonLines(filePath).slice(1);
		expect(entries.map((entry) => entry.id)).toEqual([first, second, third]);
		expect(entries.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
	});

	it("allows another session queue to progress while one session write is blocked", async () => {
		const root = createTempDir();
		const first = SessionManager.create(root, root);
		const second = SessionManager.create(root, root);
		const firstPath = first.getSessionFile()!;
		let releaseWrite!: () => void;
		let markWriteEntered!: () => void;
		const writeEntered = new Promise<void>((resolve) => {
			markWriteEntered = resolve;
		});
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		io.beforeWrite = async (path) => {
			if (path !== firstPath) return;
			markWriteEntered();
			await writeGate;
		};

		first.appendCustomMessageEntry("test", "blocked", true);
		const firstFlush = first.flush();
		let firstSettled = false;
		void firstFlush.then(() => {
			firstSettled = true;
		});
		await writeEntered;

		second.appendCustomMessageEntry("test", "independent", true);
		await second.flush();
		expect(firstSettled).toBe(false);
		expect(readJsonLines(second.getSessionFile()!).at(-1)?.content).toBe("independent");

		releaseWrite();
		await firstFlush;
	});

	it("serializes concurrent managers that append to the same session file", async () => {
		const root = createTempDir();
		const seed = SessionManager.create(root, root);
		seed.appendCustomMessageEntry("test", "seed", true);
		await seed.flush();
		const filePath = seed.getSessionFile()!;
		const first = SessionManager.open(filePath, root);
		const second = SessionManager.open(filePath, root);
		let releaseFirstWrite!: () => void;
		let markFirstWriteEntered!: () => void;
		const firstWriteEntered = new Promise<void>((resolve) => {
			markFirstWriteEntered = resolve;
		});
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let secondWriteEntered = false;
		io.beforeWrite = async (path, content) => {
			if (path !== filePath) return;
			if (content.includes('"writer":"first"')) {
				markFirstWriteEntered();
				await firstWriteGate;
			}
			if (content.includes('"writer":"second"')) {
				secondWriteEntered = true;
			}
		};

		const firstId = first.appendCustomEntry("test", { writer: "first" });
		const firstFlush = first.flush();
		await firstWriteEntered;
		const secondId = second.appendCustomEntry("test", { writer: "second" });
		const secondFlush = second.flush();
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(secondWriteEntered).toBe(false);
		} finally {
			releaseFirstWrite();
		}
		await Promise.all([firstFlush, secondFlush]);
		const persistedIds = readJsonLines(filePath).map((entry) => entry.id);
		expect(persistedIds).toContain(firstId);
		expect(persistedIds).toContain(secondId);
		expect(persistedIds.indexOf(firstId)).toBeLessThan(persistedIds.indexOf(secondId));
	});

	it("orders a migration rewrite before later appends", async () => {
		const root = createTempDir();
		const filePath = join(root, "legacy.jsonl");
		writeFileSync(
			filePath,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: "legacy",
				timestamp: "2025-01-01T00:00:00.000Z",
				cwd: root,
			})}\n`,
		);
		const manager = SessionManager.open(filePath, root);
		manager.appendCustomMessageEntry("test", "first", true);
		manager.appendCustomMessageEntry("test", "second", true);
		await manager.flush();

		const entries = readJsonLines(filePath);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "custom_message", "custom_message"]);
		expect(entries[0]?.version).toBe(5);
		expect(entries.slice(1).map((entry) => entry.content)).toEqual(["first", "second"]);
	});

	it("fsyncs durability boundaries and repairs a torn tail before the next append", async () => {
		const root = createTempDir();
		const manager = SessionManager.create(root, root);
		const filePath = manager.getSessionFile()!;
		manager.appendCustomMessageEntry("test", "initial", true);
		await manager.flush();

		io.events.length = 0;
		manager.appendCustomEntry("test", { durable: false });
		await manager.flush();
		expect(io.events.filter((event) => event.kind === "sync" && event.path === filePath)).toEqual([]);

		io.events.length = 0;
		manager.appendModelChange("provider", "model");
		await manager.flush();
		const durableEvents = io.events.filter((event) => event.path === filePath);
		expect(durableEvents.map((event) => event.kind)).toEqual(
			process.platform === "win32" ? ["open", "open", "write", "sync"] : ["open", "write", "sync"],
		);

		truncateSync(filePath, statSync(filePath).size - 1);
		io.events.length = 0;
		manager.appendCustomEntry("test", { repaired: true });
		await manager.flush();
		const repairEvents = io.events.filter(
			(event) => event.path === filePath && (event.kind === "write" || event.kind === "sync"),
		);
		expect(repairEvents.map((event) => [event.kind, event.content])).toEqual([
			["write", "\n"],
			["sync", undefined],
			["write", expect.stringContaining('"repaired":true')],
		]);
	});

	it.runIf(process.platform !== "win32")(
		"keeps files private and rejects symlink or multiply-linked targets",
		async () => {
			const root = createTempDir();
			const manager = SessionManager.create(root, root);
			manager.appendCustomMessageEntry("test", "private", true);
			await manager.flush();
			const filePath = manager.getSessionFile()!;
			expect(statSync(filePath).mode & 0o777).toBe(0o600);

			linkSync(filePath, join(root, "second-link.jsonl"));
			manager.appendCustomEntry("test", { linked: true });
			await expect(manager.flush()).rejects.toThrow("multiply-linked private file");

			const symlinkRoot = createTempDir();
			const symlinkManager = SessionManager.create(symlinkRoot, symlinkRoot);
			const referent = join(symlinkRoot, "referent.jsonl");
			writeFileSync(referent, "outside", { mode: 0o600 });
			symlinkSync(referent, symlinkManager.getSessionFile()!);
			symlinkManager.appendCustomMessageEntry("test", "must not write", true);
			await expect(symlinkManager.flush()).rejects.toThrow();
			expect(readFileSync(referent, "utf8")).toBe("outside");
		},
	);

	it("fail-stops on the first uncertain write and rejects every queue watermark", async () => {
		const root = createTempDir();
		const manager = SessionManager.create(root, root);
		const filePath = manager.getSessionFile()!;
		io.beforeWrite = async (path) => {
			if (path === filePath) throw new Error("injected asynchronous write failure");
		};

		manager.appendCustomMessageEntry("test", "first", true);
		const responsibleWatermark = manager.flush();
		manager.appendCustomEntry("test", { second: true });
		const finalWatermark = manager.flush();

		await expect(responsibleWatermark).rejects.toThrow("injected asynchronous write failure");
		await expect(finalWatermark).rejects.toThrow("injected asynchronous write failure");
		expect(manager.flush()).toBe(finalWatermark);
		expect(io.events.filter((event) => event.kind === "write" && event.path === filePath)).toHaveLength(1);
		expect(() => manager.appendCustomEntry("test", { third: true })).toThrow(
			"Session persistence is fail-stopped after an uncertain write",
		);
		await expect(manager.flush()).rejects.toThrow("injected asynchronous write failure");
	});
});
