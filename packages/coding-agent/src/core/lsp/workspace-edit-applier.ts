import { lstat, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueues } from "../tools/file-mutation-queue.ts";
import {
	applyTextEdits,
	type LspWorkspaceEdit,
	type NormalizedWorkspaceOperation,
	normalizeWorkspaceEdit,
} from "./workspace-edit.ts";

export interface WorkspaceEditDocumentSnapshot {
	uri: string;
	absolutePath: string;
	version: number;
	content: string;
}

export type AppliedWorkspaceChange =
	| { kind: "edit"; path: string; content: string }
	| { kind: "create"; path: string; content: string; overwritten: boolean }
	| { kind: "rename"; oldPath: string; newPath: string; content?: string; overwritten: boolean }
	| { kind: "delete"; path: string; recursive: boolean };

export interface WorkspaceEditApplyResult {
	applied: boolean;
	summary: string;
	changedPaths: string[];
	changes: AppliedWorkspaceChange[];
	failureReason?: string;
	failedChange?: number;
}

interface ApplyWorkspaceEditOptions {
	rootDir: string;
	edit: LspWorkspaceEdit;
	snapshots: readonly WorkspaceEditDocumentSnapshot[];
}

type EntryKind = "file" | "directory" | "other";

interface VirtualEntry {
	exists: boolean;
	kind?: EntryKind;
	content?: string;
	diskPath?: string;
	snapshotValidated?: boolean;
}

class WorkspaceEditValidationError extends Error {
	readonly operationIndex: number;

	constructor(operationIndex: number, message: string) {
		super(message);
		this.operationIndex = operationIndex;
	}
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function isPathInside(rootDir: string, absolutePath: string): boolean {
	if (!isAbsolute(absolutePath)) {
		return false;
	}
	const rel = relative(rootDir, absolutePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function operationPaths(operation: NormalizedWorkspaceOperation): string[] {
	if (operation.kind === "rename") {
		return [fileURLToPath(operation.oldUri), fileURLToPath(operation.newUri)];
	}
	return [fileURLToPath(operation.uri)];
}

async function assertCanonicalPathInRoot(rootDir: string, realRoot: string, path: string): Promise<void> {
	const absoluteRoot = resolve(rootDir);
	const absolutePath = resolve(path);
	if (!isPathInside(absoluteRoot, absolutePath)) {
		throw new Error(`Refusing to apply LSP workspace edit outside workspace root: ${absolutePath}`);
	}

	const suffix = relative(absoluteRoot, absolutePath);
	const parts = suffix === "" ? [] : suffix.split(/[\\/]+/);
	let lexicalPath = absoluteRoot;
	let canonicalPath = realRoot;
	for (let index = 0; index < parts.length; index++) {
		lexicalPath = join(lexicalPath, parts[index]);
		try {
			await lstat(lexicalPath);
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
			canonicalPath = join(canonicalPath, ...parts.slice(index));
			if (!isPathInside(realRoot, canonicalPath)) {
				throw new Error(`Refusing to apply LSP workspace edit outside workspace root: ${absolutePath}`);
			}
			return;
		}

		try {
			canonicalPath = await realpath(lexicalPath);
		} catch (error) {
			if (isMissingPathError(error)) {
				throw new Error(`Refusing to traverse dangling symlink in LSP workspace edit: ${lexicalPath}`);
			}
			throw error;
		}
		if (!isPathInside(realRoot, canonicalPath)) {
			throw new Error(`Refusing to apply LSP workspace edit outside workspace root: ${absolutePath}`);
		}
	}
}

async function assertAllPathsInRoot(rootDir: string, paths: readonly string[]): Promise<void> {
	const realRoot = await realpath(rootDir);
	for (const path of paths) {
		await assertCanonicalPathInRoot(rootDir, realRoot, path);
	}
}

async function loadEntry(path: string): Promise<VirtualEntry> {
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(path);
	} catch (error) {
		if (isMissingPathError(error)) {
			return { exists: false };
		}
		throw error;
	}
	return {
		exists: true,
		kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other",
		diskPath: path,
	};
}

async function readEntryContent(entry: VirtualEntry, operationIndex: number, path: string): Promise<string> {
	if (!entry.exists) {
		throw new WorkspaceEditValidationError(operationIndex, `Cannot edit missing or non-file document: ${path}`);
	}
	if (entry.content !== undefined) {
		return entry.content;
	}
	if (!entry.diskPath) {
		throw new WorkspaceEditValidationError(operationIndex, `Cannot edit missing or non-file document: ${path}`);
	}
	if (entry.kind !== "file") {
		let targetIsFile: boolean;
		try {
			targetIsFile = (await stat(entry.diskPath)).isFile();
		} catch (error) {
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Could not inspect LSP workspace edit input ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!targetIsFile) {
			throw new WorkspaceEditValidationError(operationIndex, `Cannot edit missing or non-file document: ${path}`);
		}
	}
	try {
		entry.content = await readFile(entry.diskPath, "utf-8");
		return entry.content;
	} catch (error) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Could not read LSP workspace edit input ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function snapshotForPath(
	snapshots: readonly WorkspaceEditDocumentSnapshot[],
	path: string,
): WorkspaceEditDocumentSnapshot | undefined {
	const resolvedPath = resolve(path);
	return snapshots.find((snapshot) => resolve(snapshot.absolutePath) === resolvedPath);
}

async function preflightOperations(
	operations: readonly NormalizedWorkspaceOperation[],
	pathsByOperation: readonly string[][],
	snapshots: readonly WorkspaceEditDocumentSnapshot[],
): Promise<void> {
	const entries = new Map<string, VirtualEntry>();
	const getEntry = async (path: string): Promise<VirtualEntry> => {
		const key = resolve(path);
		let entry = entries.get(key);
		if (!entry) {
			entry = await loadEntry(key);
			entries.set(key, entry);
		}
		return entry;
	};
	const assertParentDirectory = async (path: string, operationIndex: number): Promise<void> => {
		const parent = await getEntry(dirname(path));
		if (!parent.exists || parent.kind !== "directory") {
			throw new WorkspaceEditValidationError(operationIndex, `Parent directory does not exist for ${path}`);
		}
	};

	for (let index = 0; index < operations.length; index++) {
		const operation = operations[index];
		const paths = pathsByOperation[index];
		if (operation.kind === "edit") {
			const path = paths[0];
			const entry = await getEntry(path);
			const content = await readEntryContent(entry, index, path);
			const snapshot = snapshotForPath(snapshots, path);
			if (operation.version !== null) {
				if (!snapshot || snapshot.version !== operation.version) {
					throw new WorkspaceEditValidationError(
						index,
						`Document version mismatch for ${path}: expected ${operation.version}, current ${snapshot?.version ?? "untracked"}`,
					);
				}
			}
			if (snapshot && !entry.snapshotValidated && resolve(entry.diskPath ?? path) === resolve(path)) {
				if (content !== snapshot.content) {
					throw new WorkspaceEditValidationError(index, `Document changed after the LSP request: ${path}`);
				}
				entry.snapshotValidated = true;
			}
			try {
				entry.content = applyTextEdits(content, operation.edits);
			} catch (error) {
				throw new WorkspaceEditValidationError(
					index,
					`Invalid text edits for ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		if (operation.kind === "create") {
			const path = paths[0];
			const entry = await getEntry(path);
			if (entry.exists) {
				if (operation.options?.overwrite) {
					if (entry.kind !== "file") {
						throw new WorkspaceEditValidationError(
							index,
							`Cannot overwrite non-file resource with create: ${path}`,
						);
					}
					entry.content = "";
					entry.diskPath = undefined;
					continue;
				}
				if (operation.options?.ignoreIfExists) {
					continue;
				}
				throw new WorkspaceEditValidationError(index, `Cannot create existing resource: ${path}`);
			}
			await assertParentDirectory(path, index);
			entries.set(resolve(path), { exists: true, kind: "file", content: "" });
			continue;
		}

		if (operation.kind === "rename") {
			const [oldPath, newPath] = paths;
			if (resolve(oldPath) === resolve(newPath)) {
				continue;
			}
			const source = await getEntry(oldPath);
			if (!source.exists) {
				throw new WorkspaceEditValidationError(index, `Cannot rename missing resource: ${oldPath}`);
			}
			const destination = await getEntry(newPath);
			if (destination.exists && !operation.options?.overwrite) {
				if (operation.options?.ignoreIfExists) {
					continue;
				}
				throw new WorkspaceEditValidationError(index, `Cannot rename over existing resource: ${newPath}`);
			}
			await assertParentDirectory(newPath, index);
			entries.set(resolve(oldPath), { exists: false });
			entries.set(resolve(newPath), { ...source });
			continue;
		}

		const path = paths[0];
		const entry = await getEntry(path);
		if (!entry.exists) {
			if (operation.options?.ignoreIfNotExists) {
				continue;
			}
			throw new WorkspaceEditValidationError(index, `Cannot delete missing resource: ${path}`);
		}
		if (entry.kind === "directory" && !operation.options?.recursive) {
			let children: string[];
			try {
				children = await readdir(entry.diskPath ?? path);
			} catch (error) {
				throw new WorkspaceEditValidationError(
					index,
					`Could not inspect directory before delete ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (children.length > 0) {
				throw new WorkspaceEditValidationError(
					index,
					`Cannot delete non-empty directory without recursive: ${path}`,
				);
			}
		}
		entries.set(resolve(path), { exists: false });
	}
}

function summarize(operation: NormalizedWorkspaceOperation, paths: readonly string[], ignored: boolean): string {
	const suffix = ignored ? " (ignored)" : "";
	if (operation.kind === "edit") {
		return `${paths[0]} (${operation.edits.length} edit${operation.edits.length === 1 ? "" : "s"})`;
	}
	if (operation.kind === "create") {
		return `created ${paths[0]}${suffix}`;
	}
	if (operation.kind === "rename") {
		return `renamed ${paths[0]} -> ${paths[1]}${suffix}`;
	}
	return `deleted ${paths[0]}${suffix}`;
}

async function renameWithOverwrite(sourcePath: string, destinationPath: string, rootDir: string): Promise<void> {
	try {
		await rename(sourcePath, destinationPath);
		return;
	} catch (initialError) {
		const backupParent = dirname(destinationPath);
		if (!isPathInside(resolve(rootDir), resolve(backupParent))) {
			throw initialError;
		}
		const backupDirectory = await mkdtemp(join(backupParent, ".volt-lsp-rename-"));
		const backupPath = join(backupDirectory, "destination");
		try {
			await rename(destinationPath, backupPath);
		} catch {
			await rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
			throw initialError;
		}

		try {
			await rename(sourcePath, destinationPath);
		} catch (moveError) {
			try {
				await rename(backupPath, destinationPath);
			} catch (restoreError) {
				throw new AggregateError(
					[moveError, restoreError],
					`Failed to rename ${sourcePath} to ${destinationPath}; destination backup remains at ${backupPath}`,
				);
			}
			await rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
			throw moveError;
		}

		// The replacement is complete. Cleanup must not turn it into an unreported
		// failed mutation; if removal fails, retain the old destination as a backup.
		await rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

async function executeOperation(
	operation: NormalizedWorkspaceOperation,
	paths: readonly string[],
	rootDir: string,
): Promise<{ change?: AppliedWorkspaceChange; ignored: boolean }> {
	if (operation.kind === "edit") {
		const content = await readFile(paths[0], "utf-8");
		const nextContent = applyTextEdits(content, operation.edits);
		await writeFile(paths[0], nextContent, "utf-8");
		return { change: { kind: "edit", path: paths[0], content: nextContent }, ignored: false };
	}
	if (operation.kind === "create") {
		let exists = true;
		try {
			await lstat(paths[0]);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			exists = false;
		}
		if (exists && !operation.options?.overwrite && operation.options?.ignoreIfExists) {
			return { ignored: true };
		}
		await writeFile(paths[0], "", { flag: operation.options?.overwrite ? "w" : "wx" });
		return {
			change: { kind: "create", path: paths[0], content: "", overwritten: exists },
			ignored: false,
		};
	}
	if (operation.kind === "rename") {
		if (resolve(paths[0]) === resolve(paths[1])) {
			return { ignored: true };
		}
		let destinationExists = true;
		try {
			await lstat(paths[1]);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			destinationExists = false;
		}
		if (destinationExists && !operation.options?.overwrite && operation.options?.ignoreIfExists) {
			return { ignored: true };
		}
		if (destinationExists && operation.options?.overwrite) {
			await renameWithOverwrite(paths[0], paths[1], rootDir);
		} else {
			await rename(paths[0], paths[1]);
		}
		let content: string | undefined;
		try {
			content = await readFile(paths[1], "utf-8");
		} catch {
			// Directories and non-text resources have no document content.
		}
		return {
			change: {
				kind: "rename",
				oldPath: paths[0],
				newPath: paths[1],
				content,
				overwritten: destinationExists,
			},
			ignored: false,
		};
	}

	let exists = true;
	try {
		await lstat(paths[0]);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		exists = false;
	}
	if (!exists && operation.options?.ignoreIfNotExists) {
		return { ignored: true };
	}
	await rm(paths[0], { recursive: operation.options?.recursive ?? false, force: false });
	return {
		change: { kind: "delete", path: paths[0], recursive: operation.options?.recursive ?? false },
		ignored: false,
	};
}

/** Apply one WorkspaceEdit under a deterministic lock for every affected path. */
export async function applyWorkspaceEdit(options: ApplyWorkspaceEditOptions): Promise<WorkspaceEditApplyResult> {
	let operations: NormalizedWorkspaceOperation[];
	let pathsByOperation: string[][];
	try {
		operations = normalizeWorkspaceEdit(options.edit);
		pathsByOperation = operations.map(operationPaths);
	} catch (error) {
		return {
			applied: false,
			summary: "",
			changedPaths: [],
			changes: [],
			failureReason: error instanceof Error ? error.message : String(error),
			failedChange: 0,
		};
	}
	const allPaths = pathsByOperation.flat();

	return withFileMutationQueues(allPaths, async () => {
		try {
			await assertAllPathsInRoot(options.rootDir, allPaths);
			await preflightOperations(operations, pathsByOperation, options.snapshots);
			// Narrow the same-user symlink race after all asynchronous preflight work.
			await assertAllPathsInRoot(options.rootDir, allPaths);
		} catch (error) {
			return {
				applied: false,
				summary: "",
				changedPaths: [],
				changes: [],
				failureReason: error instanceof Error ? error.message : String(error),
				failedChange: error instanceof WorkspaceEditValidationError ? error.operationIndex : 0,
			};
		}

		const lines: string[] = [];
		const changedPaths: string[] = [];
		const changes: AppliedWorkspaceChange[] = [];
		for (let index = 0; index < operations.length; index++) {
			try {
				const result = await executeOperation(operations[index], pathsByOperation[index], options.rootDir);
				lines.push(summarize(operations[index], pathsByOperation[index], result.ignored));
				if (result.change) {
					changes.push(result.change);
					if (result.change.kind === "rename") {
						changedPaths.push(result.change.oldPath, result.change.newPath);
					} else {
						changedPaths.push(result.change.path);
					}
				}
			} catch (error) {
				return {
					applied: false,
					summary: lines.join("\n"),
					changedPaths,
					changes,
					failureReason: error instanceof Error ? error.message : String(error),
					failedChange: index,
				};
			}
		}
		return { applied: true, summary: lines.join("\n"), changedPaths, changes };
	});
}
