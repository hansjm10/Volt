import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueues } from "../tools/file-mutation-queue.ts";
import { validateWorkspaceRelativePath, type WorkspaceEntryType, WorkspaceRoot } from "../workspace-fs/index.ts";
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

interface OperationPath {
	absolutePath: string;
	relativePath: string;
}

interface VirtualEntry {
	exists: boolean;
	kind?: WorkspaceEntryType;
	content?: string;
	diskPath?: string;
	snapshotPath?: string;
	snapshotValidated?: boolean;
}

interface DirectoryMove {
	sourcePath: string;
	destinationPath: string;
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

function isPathWithinRoot(rootDir: string, absolutePath: string): boolean {
	const relativePath = relative(rootDir, absolutePath);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function portableRelativePath(relativePath: string): string {
	return sep === "/" ? relativePath : relativePath.split(sep).join("/");
}

function operationUris(operation: NormalizedWorkspaceOperation): string[] {
	if (operation.kind === "rename") {
		return [operation.oldUri, operation.newUri];
	}
	return [operation.uri];
}

function operationPath(rootDir: string, uri: string, operationIndex: number): OperationPath {
	let absolutePath: string;
	try {
		absolutePath = resolve(fileURLToPath(uri));
	} catch (error) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Invalid LSP workspace edit URI ${uri}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPathWithinRoot(rootDir, absolutePath)) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Refusing to apply LSP workspace edit outside workspace root: ${absolutePath}`,
		);
	}
	try {
		const relativePath = validateWorkspaceRelativePath(portableRelativePath(relative(rootDir, absolutePath)), {
			operation: "applyWorkspaceEdit",
		});
		return { absolutePath, relativePath };
	} catch (error) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Invalid LSP workspace edit path ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function relativeSnapshotPath(rootDir: string, absolutePath: string): string | undefined {
	const resolvedPath = resolve(absolutePath);
	if (!isPathWithinRoot(rootDir, resolvedPath)) return undefined;
	const relativePath = portableRelativePath(relative(rootDir, resolvedPath));
	if (relativePath === "") return undefined;
	try {
		return validateWorkspaceRelativePath(relativePath, { operation: "snapshot" });
	} catch {
		return undefined;
	}
}

function snapshotsByRelativePath(
	rootDir: string,
	snapshots: readonly WorkspaceEditDocumentSnapshot[],
): Map<string, WorkspaceEditDocumentSnapshot> {
	const byPath = new Map<string, WorkspaceEditDocumentSnapshot>();
	for (const snapshot of snapshots) {
		const relativePath = relativeSnapshotPath(rootDir, snapshot.absolutePath);
		if (relativePath !== undefined && !byPath.has(relativePath)) {
			byPath.set(relativePath, snapshot);
		}
	}
	return byPath;
}

function isSameOrDescendant(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

function remapDescendant(path: string, oldParent: string, newParent: string): string {
	if (path === oldParent) return newParent;
	return `${newParent}${path.slice(oldParent.length)}`;
}

function resolveBackingPath(path: string, directoryMoves: readonly DirectoryMove[]): string {
	let current = path;
	const visited = new Set([current]);
	for (const move of directoryMoves) {
		if (!isSameOrDescendant(current, move.destinationPath)) continue;
		current = remapDescendant(current, move.destinationPath, move.sourcePath);
		if (visited.has(current)) {
			throw new Error(`Directory rename cycle reaches ${current}`);
		}
		visited.add(current);
	}
	return current;
}

function blockingAncestor(path: string, entries: ReadonlyMap<string, VirtualEntry>): boolean {
	let ancestor = posix.dirname(path);
	while (true) {
		const entry = entries.get(ancestor);
		if (entry && (!entry.exists || entry.kind !== "directory")) return true;
		if (ancestor === ".") return false;
		ancestor = posix.dirname(ancestor);
	}
}

async function loadEntry(
	root: WorkspaceRoot,
	path: string,
	displayPath: string,
	operationIndex: number,
): Promise<VirtualEntry> {
	try {
		const metadata = await root.lstat(path);
		return {
			exists: true,
			kind: metadata.type,
			diskPath: path,
			snapshotPath: path,
		};
	} catch (error) {
		if (isMissingPathError(error)) return { exists: false };
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Could not inspect LSP workspace edit input ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readEntryContent(
	root: WorkspaceRoot,
	entry: VirtualEntry,
	operationIndex: number,
	displayPath: string,
): Promise<string> {
	if (!entry.exists || (entry.content === undefined && entry.diskPath === undefined)) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Cannot edit missing or non-file document: ${displayPath}`,
		);
	}
	if (entry.content !== undefined) return entry.content;
	const diskPath = entry.diskPath;
	if (diskPath === undefined) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Cannot edit missing or non-file document: ${displayPath}`,
		);
	}
	if (entry.kind !== "file") {
		if (entry.kind !== "symlink") {
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Cannot edit missing or non-file document: ${displayPath}`,
			);
		}
		try {
			if ((await root.metadata(diskPath)).type !== "file") {
				throw new WorkspaceEditValidationError(
					operationIndex,
					`Cannot edit missing or non-file document: ${displayPath}`,
				);
			}
		} catch (error) {
			if (error instanceof WorkspaceEditValidationError) throw error;
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Could not inspect LSP workspace edit input ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	try {
		entry.content = (await root.readFile(diskPath)).toString("utf8");
		return entry.content;
	} catch (error) {
		throw new WorkspaceEditValidationError(
			operationIndex,
			`Could not read LSP workspace edit input ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function tombstoneVirtualSubtree(entries: Map<string, VirtualEntry>, path: string): void {
	for (const candidate of entries.keys()) {
		if (isSameOrDescendant(candidate, path)) entries.delete(candidate);
	}
	entries.set(path, { exists: false });
}

function moveVirtualSubtree(entries: Map<string, VirtualEntry>, sourcePath: string, destinationPath: string): void {
	const sourceEntries = [...entries].filter(([path]) => isSameOrDescendant(path, sourcePath));
	for (const path of [...entries.keys()]) {
		if (isSameOrDescendant(path, sourcePath) || isSameOrDescendant(path, destinationPath)) {
			entries.delete(path);
		}
	}
	for (const [path, entry] of sourceEntries) {
		entries.set(remapDescendant(path, sourcePath, destinationPath), entry);
	}
	entries.set(sourcePath, { exists: false });
}

function directChildName(parent: string, candidate: string): string | undefined {
	if (parent === ".") {
		return candidate !== "." && !candidate.includes("/") ? candidate : undefined;
	}
	if (!candidate.startsWith(`${parent}/`)) return undefined;
	const suffix = candidate.slice(parent.length + 1);
	return suffix.length > 0 && !suffix.includes("/") ? suffix : undefined;
}

async function preflightOperations(
	root: WorkspaceRoot,
	operations: readonly NormalizedWorkspaceOperation[],
	pathsByOperation: readonly OperationPath[][],
	snapshots: ReadonlyMap<string, WorkspaceEditDocumentSnapshot>,
): Promise<void> {
	const entries = new Map<string, VirtualEntry>();
	const directoryMoves: DirectoryMove[] = [];
	const getEntry = async (path: OperationPath, operationIndex: number): Promise<VirtualEntry> => {
		const existing = entries.get(path.relativePath);
		if (existing) return existing;
		if (blockingAncestor(path.relativePath, entries)) return { exists: false };
		let backingPath: string;
		try {
			backingPath = resolveBackingPath(path.relativePath, directoryMoves);
		} catch (error) {
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Could not resolve virtual workspace path ${path.absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const entry = await loadEntry(root, backingPath, path.absolutePath, operationIndex);
		entries.set(path.relativePath, entry);
		return entry;
	};
	const assertParentDirectory = async (path: OperationPath, operationIndex: number): Promise<void> => {
		const parentRelativePath = posix.dirname(path.relativePath);
		const parent = await getEntry(
			{
				absolutePath: resolve(path.absolutePath, ".."),
				relativePath: parentRelativePath,
			},
			operationIndex,
		);
		if (!parent.exists || parent.kind !== "directory") {
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Parent directory does not exist for ${path.absolutePath}`,
			);
		}
	};
	const directoryHasChildren = async (
		path: OperationPath,
		entry: VirtualEntry,
		operationIndex: number,
	): Promise<boolean> => {
		if (entry.diskPath === undefined) return false;
		let diskNames: string[];
		try {
			diskNames = (await root.readDirectory(entry.diskPath)).map((child) => child.name);
		} catch (error) {
			throw new WorkspaceEditValidationError(
				operationIndex,
				`Could not inspect directory before delete ${path.absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const names = new Set(diskNames);
		for (const candidate of entries.keys()) {
			const name = directChildName(path.relativePath, candidate);
			if (name !== undefined) names.add(name);
		}
		for (const name of names) {
			const childRelativePath = path.relativePath === "." ? name : `${path.relativePath}/${name}`;
			const child = await getEntry(
				{
					absolutePath: resolve(path.absolutePath, name),
					relativePath: childRelativePath,
				},
				operationIndex,
			);
			if (child.exists) return true;
		}
		return false;
	};

	for (let index = 0; index < operations.length; index++) {
		const operation = operations[index];
		const paths = pathsByOperation[index];
		if (operation.kind === "edit") {
			const path = paths[0];
			const entry = await getEntry(path, index);
			const content = await readEntryContent(root, entry, index, path.absolutePath);
			const snapshot = entry.snapshotPath === undefined ? undefined : snapshots.get(entry.snapshotPath);
			if (operation.version !== null && (!snapshot || snapshot.version !== operation.version)) {
				throw new WorkspaceEditValidationError(
					index,
					`Document version mismatch for ${path.absolutePath}: expected ${operation.version}, current ${snapshot?.version ?? "untracked"}`,
				);
			}
			if (snapshot && !entry.snapshotValidated) {
				if (content !== snapshot.content) {
					throw new WorkspaceEditValidationError(
						index,
						`Document changed after the LSP request: ${path.absolutePath}`,
					);
				}
				entry.snapshotValidated = true;
			}
			try {
				entry.content = applyTextEdits(content, operation.edits);
			} catch (error) {
				throw new WorkspaceEditValidationError(
					index,
					`Invalid text edits for ${path.absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			continue;
		}

		if (operation.kind === "create") {
			const path = paths[0];
			const entry = await getEntry(path, index);
			if (entry.exists) {
				if (operation.options?.overwrite) {
					if (entry.kind !== "file") {
						throw new WorkspaceEditValidationError(
							index,
							`Cannot overwrite non-file resource with create: ${path.absolutePath}`,
						);
					}
					entries.set(path.relativePath, { exists: true, kind: "file", content: "" });
					continue;
				}
				if (operation.options?.ignoreIfExists) continue;
				throw new WorkspaceEditValidationError(index, `Cannot create existing resource: ${path.absolutePath}`);
			}
			await assertParentDirectory(path, index);
			entries.set(path.relativePath, { exists: true, kind: "file", content: "" });
			continue;
		}

		if (operation.kind === "rename") {
			const [oldPath, newPath] = paths;
			if (oldPath.relativePath === newPath.relativePath) continue;
			const source = await getEntry(oldPath, index);
			if (!source.exists) {
				throw new WorkspaceEditValidationError(index, `Cannot rename missing resource: ${oldPath.absolutePath}`);
			}
			const destination = await getEntry(newPath, index);
			if (destination.exists && !operation.options?.overwrite) {
				if (operation.options?.ignoreIfExists) continue;
				throw new WorkspaceEditValidationError(
					index,
					`Cannot rename over existing resource: ${newPath.absolutePath}`,
				);
			}
			await assertParentDirectory(newPath, index);
			if (source.kind === "directory") {
				if (
					isSameOrDescendant(oldPath.relativePath, newPath.relativePath) ||
					isSameOrDescendant(newPath.relativePath, oldPath.relativePath)
				) {
					throw new WorkspaceEditValidationError(
						index,
						`Cannot rename overlapping directory subtree ${oldPath.absolutePath} to ${newPath.absolutePath}`,
					);
				}
				const move = {
					sourcePath: oldPath.relativePath,
					destinationPath: newPath.relativePath,
				};
				try {
					resolveBackingPath(newPath.relativePath, [move, ...directoryMoves]);
				} catch {
					throw new WorkspaceEditValidationError(
						index,
						`Cannot create directory rename cycle from ${oldPath.absolutePath} to ${newPath.absolutePath}`,
					);
				}
				directoryMoves.unshift(move);
			}
			moveVirtualSubtree(entries, oldPath.relativePath, newPath.relativePath);
			continue;
		}

		const path = paths[0];
		const entry = await getEntry(path, index);
		if (!entry.exists) {
			if (operation.options?.ignoreIfNotExists) continue;
			throw new WorkspaceEditValidationError(index, `Cannot delete missing resource: ${path.absolutePath}`);
		}
		if (entry.kind === "directory" && !operation.options?.recursive) {
			if (await directoryHasChildren(path, entry, index)) {
				throw new WorkspaceEditValidationError(
					index,
					`Cannot delete non-empty directory without recursive: ${path.absolutePath}`,
				);
			}
		}
		tombstoneVirtualSubtree(entries, path.relativePath);
	}
}

function summarize(operation: NormalizedWorkspaceOperation, paths: readonly OperationPath[], ignored: boolean): string {
	const suffix = ignored ? " (ignored)" : "";
	if (operation.kind === "edit") {
		return `${paths[0].absolutePath} (${operation.edits.length} edit${operation.edits.length === 1 ? "" : "s"})`;
	}
	if (operation.kind === "create") {
		return `created ${paths[0].absolutePath}${suffix}`;
	}
	if (operation.kind === "rename") {
		return `renamed ${paths[0].absolutePath} -> ${paths[1].absolutePath}${suffix}`;
	}
	return `deleted ${paths[0].absolutePath}${suffix}`;
}

async function rootedPathExists(root: WorkspaceRoot, relativePath: string): Promise<boolean> {
	try {
		await root.lstat(relativePath);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

async function executeOperation(
	root: WorkspaceRoot,
	operation: NormalizedWorkspaceOperation,
	paths: readonly OperationPath[],
): Promise<{ change?: AppliedWorkspaceChange; ignored: boolean }> {
	if (operation.kind === "edit") {
		const content = (await root.readFile(paths[0].relativePath)).toString("utf8");
		const nextContent = applyTextEdits(content, operation.edits);
		await root.replaceFile(paths[0].relativePath, Buffer.from(nextContent, "utf8"));
		return { change: { kind: "edit", path: paths[0].absolutePath, content: nextContent }, ignored: false };
	}
	if (operation.kind === "create") {
		const exists = await rootedPathExists(root, paths[0].relativePath);
		if (exists && !operation.options?.overwrite && operation.options?.ignoreIfExists) {
			return { ignored: true };
		}
		if (operation.options?.overwrite) {
			await root.replaceFile(paths[0].relativePath, Buffer.alloc(0));
		} else {
			await root.createFile(paths[0].relativePath, Buffer.alloc(0));
		}
		return {
			change: { kind: "create", path: paths[0].absolutePath, content: "", overwritten: exists },
			ignored: false,
		};
	}
	if (operation.kind === "rename") {
		if (paths[0].relativePath === paths[1].relativePath) return { ignored: true };
		const destinationExists = await rootedPathExists(root, paths[1].relativePath);
		if (destinationExists && !operation.options?.overwrite && operation.options?.ignoreIfExists) {
			return { ignored: true };
		}
		await root.rename(paths[0].relativePath, paths[1].relativePath, {
			overwrite: operation.options?.overwrite === true,
		});
		const destinationMetadata = await root.lstat(paths[1].relativePath);
		const content =
			destinationMetadata.type === "file"
				? (await root.readFile(paths[1].relativePath)).toString("utf8")
				: undefined;
		return {
			change: {
				kind: "rename",
				oldPath: paths[0].absolutePath,
				newPath: paths[1].absolutePath,
				content,
				overwritten: destinationExists,
			},
			ignored: false,
		};
	}

	const exists = await rootedPathExists(root, paths[0].relativePath);
	if (!exists && operation.options?.ignoreIfNotExists) return { ignored: true };
	await root.remove(paths[0].relativePath, { recursive: operation.options?.recursive ?? false });
	return {
		change: {
			kind: "delete",
			path: paths[0].absolutePath,
			recursive: operation.options?.recursive ?? false,
		},
		ignored: false,
	};
}

function failedResult(error: unknown, failedChange: number): WorkspaceEditApplyResult {
	return {
		applied: false,
		summary: "",
		changedPaths: [],
		changes: [],
		failureReason: error instanceof Error ? error.message : String(error),
		failedChange,
	};
}

/** Apply one WorkspaceEdit under a deterministic lock for every affected path. */
export async function applyWorkspaceEdit(options: ApplyWorkspaceEditOptions): Promise<WorkspaceEditApplyResult> {
	const rootDir = resolve(options.rootDir);
	let operations: NormalizedWorkspaceOperation[];
	let pathsByOperation: OperationPath[][];
	try {
		operations = normalizeWorkspaceEdit(options.edit);
		pathsByOperation = operations.map((operation, index) =>
			operationUris(operation).map((uri) => operationPath(rootDir, uri, index)),
		);
	} catch (error) {
		return failedResult(error, error instanceof WorkspaceEditValidationError ? error.operationIndex : 0);
	}
	const allPaths = pathsByOperation.flat().map((path) => path.absolutePath);

	return withFileMutationQueues(allPaths, async () => {
		let root: WorkspaceRoot;
		try {
			root = new WorkspaceRoot(rootDir);
		} catch (error) {
			return failedResult(error, 0);
		}
		try {
			try {
				await preflightOperations(
					root,
					operations,
					pathsByOperation,
					snapshotsByRelativePath(rootDir, options.snapshots),
				);
			} catch (error) {
				return failedResult(error, error instanceof WorkspaceEditValidationError ? error.operationIndex : 0);
			}

			const lines: string[] = [];
			const changedPaths: string[] = [];
			const changes: AppliedWorkspaceChange[] = [];
			for (let index = 0; index < operations.length; index++) {
				try {
					const result = await executeOperation(root, operations[index], pathsByOperation[index]);
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
		} finally {
			root.close();
		}
	});
}
