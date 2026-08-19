import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type LspApplyEditResult, LspClient } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { applyTextEdits, type LspWorkspaceEdit, normalizeWorkspaceEdit } from "../src/core/lsp/workspace-edit.ts";
import { applyWorkspaceEdit, type WorkspaceEditDocumentSnapshot } from "../src/core/lsp/workspace-edit-applier.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { directorySymlinkType } from "./symlink-utils.ts";

const FAKE_SERVER = join(__dirname, "fixtures", "fake-lsp-server.mjs");
const tempDirs: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function createTempDir(prefix = "volt-lsp-workspace-edit-"): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(path);
	return path;
}

function uri(path: string): string {
	return pathToFileURL(path).toString();
}

function replaceFirst(
	uriValue: string,
	find: string,
	replacement: string,
	version: number | null = null,
): LspWorkspaceEdit {
	return {
		documentChanges: [
			{
				textDocument: { uri: uriValue, version },
				edits: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: find.length } },
						newText: replacement,
					},
				],
			},
		],
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceEdit protocol planning", () => {
	it("preserves versions, resource options, and operation order", () => {
		expect(
			normalizeWorkspaceEdit({
				documentChanges: [
					{ textDocument: { uri: "file:///a", version: 7 }, edits: [] },
					{ kind: "create", uri: "file:///b", options: { overwrite: true, ignoreIfExists: true } },
					{
						kind: "rename",
						oldUri: "file:///b",
						newUri: "file:///c",
						options: { overwrite: true, ignoreIfExists: true },
					},
					{ kind: "delete", uri: "file:///c", options: { recursive: true, ignoreIfNotExists: true } },
				],
			}),
		).toEqual([
			{ kind: "edit", uri: "file:///a", version: 7, edits: [] },
			{ kind: "create", uri: "file:///b", options: { overwrite: true, ignoreIfExists: true } },
			{
				kind: "rename",
				oldUri: "file:///b",
				newUri: "file:///c",
				options: { overwrite: true, ignoreIfExists: true },
			},
			{ kind: "delete", uri: "file:///c", options: { recursive: true, ignoreIfNotExists: true } },
		]);
	});

	it("allows same-position inserts but rejects overlapping and reversed ranges", () => {
		const position = { line: 0, character: 1 };
		expect(
			applyTextEdits("ab", [
				{ range: { start: position, end: position }, newText: "X" },
				{ range: { start: position, end: position }, newText: "Y" },
			]),
		).toBe("aXYb");
		expect(() =>
			applyTextEdits("abcd", [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x" },
				{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "y" },
			]),
		).toThrow("overlapping");
		expect(() =>
			applyTextEdits("abcd", [
				{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 1 } }, newText: "x" },
			]),
		).toThrow("reversed");
	});

	it("clamps positions before LF, CRLF, and CR terminators and preserves EOF clamping", () => {
		const content = "lf\ncrlf\r\ncr\rend";
		const result = applyTextEdits(content, [
			{ range: { start: { line: 0, character: 99 }, end: { line: 0, character: 99 } }, newText: "!" },
			{ range: { start: { line: 1, character: 99 }, end: { line: 1, character: 99 } }, newText: "!" },
			{ range: { start: { line: 2, character: 99 }, end: { line: 2, character: 99 } }, newText: "!" },
			{ range: { start: { line: 99, character: 0 }, end: { line: 99, character: 0 } }, newText: "!" },
		]);
		expect(result).toBe("lf!\ncrlf!\r\ncr!\rend!");
	});
});

describe("WorkspaceEdit applier", () => {
	it("rejects direct and symlink-mediated paths outside the canonical root", async () => {
		const root = await createTempDir();
		const outside = await createTempDir("volt-lsp-outside-");
		const outsideFile = join(outside, "outside.foo");
		await writeFile(outsideFile, "secret", "utf-8");

		const direct = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(outsideFile), "secret", "pwned"),
			snapshots: [],
		});
		expect(direct).toMatchObject({ applied: false, failedChange: 0 });

		const fileAlias = join(root, "file-alias.foo");
		try {
			await symlink(outsideFile, fileAlias, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		const fileEscape = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(fileAlias), "secret", "pwned"),
			snapshots: [],
		});
		expect(fileEscape.applied).toBe(false);

		const directoryAlias = join(root, "directory-alias");
		await symlink(outside, directoryAlias, directorySymlinkType());
		const directoryEscape = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(join(directoryAlias, "outside.foo")), "secret", "pwned"),
			snapshots: [],
		});
		expect(directoryEscape.applied).toBe(false);
		expect(await readFile(outsideFile, "utf-8")).toBe("secret");
	});

	it("rejects dangling symlink traversal", async () => {
		const root = await createTempDir();
		const dangling = join(root, "dangling.foo");
		try {
			await symlink(join(root, "missing-target.foo"), dangling, "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		const result = await applyWorkspaceEdit({
			rootDir: root,
			edit: { documentChanges: [{ kind: "create", uri: uri(dangling), options: { overwrite: true } }] },
			snapshots: [],
		});
		expect(result).toMatchObject({ applied: false, failedChange: 0 });
		expect(result.failureReason).toContain("dangling symlink");
	});

	it("fails closed for version mismatches and stale request snapshots", async () => {
		const root = await createTempDir();
		const path = join(root, "versioned.foo");
		await writeFile(path, "old", "utf-8");
		const snapshot: WorkspaceEditDocumentSnapshot = {
			uri: uri(path),
			absolutePath: path,
			version: 3,
			content: "old",
		};

		const mismatched = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(path), "old", "new", 2),
			snapshots: [snapshot],
		});
		expect(mismatched).toMatchObject({ applied: false, failedChange: 0 });
		expect(mismatched.failureReason).toContain("version mismatch");

		await writeFile(path, "raced", "utf-8");
		const stale = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(path), "old", "new"),
			snapshots: [snapshot],
		});
		expect(stale.applied).toBe(false);
		expect(stale.failureReason).toContain("changed after the LSP request");
		expect(await readFile(path, "utf-8")).toBe("raced");
	});

	it("detects a stale snapshot after racing the write tool on the shared lock", async () => {
		const root = await createTempDir();
		const path = join(root, "raced.foo");
		await writeFile(path, "old", "utf-8");
		const writeStarted = deferred();
		const releaseWrite = deferred();
		const writeTool = createWriteTool(root, {
			operations: {
				mkdir: async () => {},
				writeFile: async (target, content) => {
					writeStarted.resolve();
					await releaseWrite.promise;
					await writeFile(target, content, "utf-8");
				},
			},
		});
		const writePromise = writeTool.execute("write", { path, content: "tool-write" });
		await writeStarted.promise;
		const applyPromise = applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(path), "old", "server"),
			snapshots: [{ uri: uri(path), absolutePath: path, version: 1, content: "old" }],
		});
		releaseWrite.resolve();
		await writePromise;
		const result = await applyPromise;
		expect(result.applied).toBe(false);
		expect(result.failureReason).toContain("changed after the LSP request");
		expect(await readFile(path, "utf-8")).toBe("tool-write");
	});

	it("detects a stale snapshot after racing the edit tool on the shared lock", async () => {
		const root = await createTempDir();
		const path = join(root, "edited-race.foo");
		await writeFile(path, "old value", "utf-8");
		const editWriteStarted = deferred();
		const releaseEditWrite = deferred();
		const editTool = createEditTool(root, {
			operations: {
				access,
				readFile: (target) => readFile(target),
				writeFile: async (target, content) => {
					editWriteStarted.resolve();
					await releaseEditWrite.promise;
					await writeFile(target, content, "utf-8");
				},
			},
		});
		const editPromise = editTool.execute("edit", {
			path,
			edits: [{ oldText: "old", newText: "tool" }],
		});
		await editWriteStarted.promise;
		const applyPromise = applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(path), "old", "server"),
			snapshots: [{ uri: uri(path), absolutePath: path, version: 1, content: "old value" }],
		});
		releaseEditWrite.resolve();
		await editPromise;
		const result = await applyPromise;
		expect(result.applied).toBe(false);
		expect(result.failureReason).toContain("changed after the LSP request");
		expect(await readFile(path, "utf-8")).toBe("tool value");
	});

	it("fails for missing and unreadable text-edit inputs without creating content", async () => {
		const root = await createTempDir();
		const missing = join(root, "missing.foo");
		const missingResult = await applyWorkspaceEdit({
			rootDir: root,
			edit: replaceFirst(uri(missing), "", "new"),
			snapshots: [],
		});
		expect(missingResult.applied).toBe(false);
		expect(await pathExists(missing)).toBe(false);

		if (process.platform === "win32") return;
		const unreadable = join(root, "unreadable.foo");
		await writeFile(unreadable, "old", "utf-8");
		await chmod(unreadable, 0o000);
		try {
			const unreadableResult = await applyWorkspaceEdit({
				rootDir: root,
				edit: replaceFirst(uri(unreadable), "old", "new"),
				snapshots: [],
			});
			if (process.getuid?.() !== 0) {
				expect(unreadableResult.applied).toBe(false);
				expect(unreadableResult.failureReason).toContain("Could not read");
			}
		} finally {
			await chmod(unreadable, 0o600);
		}
	});

	it("preflights every operation before mutation", async () => {
		const root = await createTempDir();
		const first = join(root, "first.foo");
		const missing = join(root, "missing.foo");
		await writeFile(first, "old", "utf-8");
		const result = await applyWorkspaceEdit({
			rootDir: root,
			edit: {
				documentChanges: [
					...replaceFirst(uri(first), "old", "new").documentChanges!,
					...replaceFirst(uri(missing), "", "created").documentChanges!,
				],
			},
			snapshots: [],
		});
		expect(result).toMatchObject({ applied: false, failedChange: 1, changes: [] });
		expect(await readFile(first, "utf-8")).toBe("old");
	});

	it("applies ordered create, edit, rename, and delete operations", async () => {
		const root = await createTempDir();
		const created = join(root, "created.foo");
		const renamed = join(root, "renamed.foo");
		const result = await applyWorkspaceEdit({
			rootDir: root,
			edit: {
				documentChanges: [
					{ kind: "create", uri: uri(created) },
					{
						textDocument: { uri: uri(created), version: null },
						edits: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
								newText: "content",
							},
						],
					},
					{ kind: "rename", oldUri: uri(created), newUri: uri(renamed) },
					{ kind: "delete", uri: uri(renamed) },
				],
			},
			snapshots: [],
		});
		expect(result.applied).toBe(true);
		expect(result.changes.map((change) => change.kind)).toEqual(["create", "edit", "rename", "delete"]);
		expect(await pathExists(created)).toBe(false);
		expect(await pathExists(renamed)).toBe(false);
	});

	it("honors create overwrite and ignoreIfExists options", async () => {
		const root = await createTempDir();
		const path = join(root, "create.foo");
		await writeFile(path, "existing", "utf-8");
		const ignored = await applyWorkspaceEdit({
			rootDir: root,
			edit: { documentChanges: [{ kind: "create", uri: uri(path), options: { ignoreIfExists: true } }] },
			snapshots: [],
		});
		expect(ignored.applied).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("existing");
		const overwritten = await applyWorkspaceEdit({
			rootDir: root,
			edit: {
				documentChanges: [{ kind: "create", uri: uri(path), options: { overwrite: true, ignoreIfExists: true } }],
			},
			snapshots: [],
		});
		expect(overwritten.applied).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("");
	});

	it("honors rename overwrite and ignoreIfExists options", async () => {
		const root = await createTempDir();
		const source = join(root, "source.foo");
		const destination = join(root, "destination.foo");
		await writeFile(source, "source", "utf-8");
		await writeFile(destination, "destination", "utf-8");
		const ignored = await applyWorkspaceEdit({
			rootDir: root,
			edit: {
				documentChanges: [
					{ kind: "rename", oldUri: uri(source), newUri: uri(destination), options: { ignoreIfExists: true } },
				],
			},
			snapshots: [],
		});
		expect(ignored.applied).toBe(true);
		expect(await readFile(source, "utf-8")).toBe("source");
		const overwritten = await applyWorkspaceEdit({
			rootDir: root,
			edit: {
				documentChanges: [
					{
						kind: "rename",
						oldUri: uri(source),
						newUri: uri(destination),
						options: { overwrite: true, ignoreIfExists: true },
					},
				],
			},
			snapshots: [],
		});
		expect(overwritten.applied).toBe(true);
		expect(await pathExists(source)).toBe(false);
		expect(await readFile(destination, "utf-8")).toBe("source");
	});

	it("honors delete recursive and ignoreIfNotExists options", async () => {
		const root = await createTempDir();
		const missing = join(root, "missing");
		const ignored = await applyWorkspaceEdit({
			rootDir: root,
			edit: { documentChanges: [{ kind: "delete", uri: uri(missing), options: { ignoreIfNotExists: true } }] },
			snapshots: [],
		});
		expect(ignored.applied).toBe(true);

		const directory = join(root, "directory");
		await mkdir(directory);
		await writeFile(join(directory, "child.foo"), "x", "utf-8");
		const nonRecursive = await applyWorkspaceEdit({
			rootDir: root,
			edit: { documentChanges: [{ kind: "delete", uri: uri(directory) }] },
			snapshots: [],
		});
		expect(nonRecursive.applied).toBe(false);
		expect(await pathExists(directory)).toBe(true);
		const recursive = await applyWorkspaceEdit({
			rootDir: root,
			edit: { documentChanges: [{ kind: "delete", uri: uri(directory), options: { recursive: true } }] },
			snapshots: [],
		});
		expect(recursive.applied).toBe(true);
		expect(await pathExists(directory)).toBe(false);
	});
});

describe("LSP WorkspaceEdit integration", () => {
	it("advertises abort handling, reports structured failures, and reconciles exact document events", async () => {
		const root = await createTempDir();
		let client!: LspClient;
		let requestSnapshots: WorkspaceEditDocumentSnapshot[] = [];
		client = new LspClient({
			serverName: "fake",
			command: [process.execPath, FAKE_SERVER],
			rootDir: root,
			onApplyEdit: async (edit): Promise<LspApplyEditResult> => {
				const result = await applyWorkspaceEdit({
					rootDir: root,
					edit: edit as LspWorkspaceEdit,
					snapshots: requestSnapshots,
				});
				await client.applyWorkspaceChanges(result.changes);
				return { applied: result.applied, failureReason: result.failureReason, failedChange: result.failedChange };
			},
		});
		try {
			const oldPath = join(root, "open.foo");
			const newPath = join(root, "moved.foo");
			await writeFile(oldPath, "open", "utf-8");
			await client.openDocument(oldPath, "open");
			requestSnapshots = client.captureWorkspaceEditSnapshots();
			const renamed = await client.sendRequest("fake/applyEdit", {
				edit: { documentChanges: [{ kind: "rename", oldUri: uri(oldPath), newUri: uri(newPath) }] },
			});
			expect(renamed).toEqual({ applied: true });

			requestSnapshots = client.captureWorkspaceEditSnapshots();
			const deleted = await client.sendRequest("fake/applyEdit", {
				edit: { documentChanges: [{ kind: "delete", uri: uri(newPath) }] },
			});
			expect(deleted).toEqual({ applied: true });

			const createdPath = join(root, "created.foo");
			requestSnapshots = client.captureWorkspaceEditSnapshots();
			await client.sendRequest("fake/applyEdit", {
				edit: { documentChanges: [{ kind: "create", uri: uri(createdPath) }] },
			});
			requestSnapshots = client.captureWorkspaceEditSnapshots();
			await client.sendRequest("fake/applyEdit", { edit: replaceFirst(uri(createdPath), "", "created") });

			const stablePath = join(root, "stable.foo");
			await writeFile(stablePath, "stable", "utf-8");
			requestSnapshots = client.captureWorkspaceEditSnapshots();
			const failed = (await client.sendRequest("fake/applyEdit", {
				edit: {
					documentChanges: [
						...replaceFirst(uri(stablePath), "stable", "changed").documentChanges!,
						...replaceFirst(uri(join(root, "missing.foo")), "", "bad").documentChanges!,
					],
				},
			})) as LspApplyEditResult;
			expect(failed.applied).toBe(false);
			expect(failed.failedChange).toBe(1);
			expect(failed.failureReason).toContain("missing or non-file");
			expect(await readFile(stablePath, "utf-8")).toBe("stable");

			const state = (await client.sendRequest("fake/state", {})) as {
				opens: string[];
				closes: string[];
				changes: Array<{ uri: string; version: number }>;
				watched: Array<{ uri: string; type: number }>;
				initializeCapabilities: { workspace: { workspaceEdit: { failureHandling: string } } };
			};
			expect(state.initializeCapabilities.workspace.workspaceEdit.failureHandling).toBe("abort");
			expect(state.opens).toEqual([uri(oldPath), uri(newPath)]);
			expect(state.closes).toEqual([uri(oldPath), uri(newPath)]);
			expect(state.changes).toEqual([]);
			expect(state.watched).toEqual([
				{ uri: uri(createdPath), type: 1 },
				{ uri: uri(createdPath), type: 2 },
			]);
		} finally {
			client.dispose();
		}
	});

	it("rejects a delayed stale command edit and isolates concurrent command summaries", async () => {
		const root = await createTempDir();
		const manager = new LspManager({
			cwd: root,
			config: resolveLspConfig({
				enabled: true,
				settleMs: 1000,
				servers: {
					typescript: { enabled: false },
					python: { enabled: false },
					go: { enabled: false },
					rust: { enabled: false },
					fake: { command: [process.execPath, FAKE_SERVER], fileExtensions: [".foo"], rootMarkers: [] },
				},
			}),
		});
		try {
			const delayedPath = join(root, "delayed.foo");
			await writeFile(delayedPath, "DELAYED_CMDFIX", "utf-8");
			const delayedFix = manager.codeFix(delayedPath, { line: 1 });
			await new Promise((resolve) => setTimeout(resolve, 75));
			await writeFile(delayedPath, "changed by write tool", "utf-8");
			const delayedResult = await delayedFix;
			expect(delayedResult).toContain("no workspace edits reported");
			expect(await readFile(delayedPath, "utf-8")).toBe("changed by write tool");

			const firstPath = join(root, "first.foo");
			const secondPath = join(root, "second.foo");
			await writeFile(firstPath, "CMDFIX first", "utf-8");
			await writeFile(secondPath, "CMDFIX second", "utf-8");
			await manager.documentSymbols(firstPath);
			await manager.documentSymbols(secondPath);
			const [firstResult, secondResult] = await Promise.all([
				manager.codeFix(firstPath, { line: 1 }),
				manager.codeFix(secondPath, { line: 1 }),
			]);
			expect(firstResult).toContain("first.foo (1 edit)");
			expect(firstResult).not.toContain("second.foo (1 edit)");
			expect(secondResult).toContain("second.foo (1 edit)");
			expect(secondResult).not.toContain("first.foo (1 edit)");
		} finally {
			manager.dispose();
		}
	});
});
