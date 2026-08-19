import * as path from "node:path";
import {
	loadWorkspaceFsNativeAddon,
	type NativeDirectoryEntry,
	type NativeMetadata,
	type NativeWorkspaceRoot,
	WorkspaceFsNativeUnavailableError,
} from "./native-loader.ts";

export { WorkspaceFsNativeUnavailableError } from "./native-loader.ts";

export type WorkspaceEntryType = "file" | "directory" | "symlink" | "other";

export type WorkspaceMetadata = {
	type: WorkspaceEntryType;
	size: number;
	modifiedMs: number;
	mode?: number;
};

export type WorkspaceDirectoryEntry = {
	name: string;
	type: WorkspaceEntryType;
};

export type WorkspaceRenameOptions = {
	overwrite?: boolean;
};

export type WorkspaceRemoveOptions = {
	recursive?: boolean;
};

export class WorkspaceFsError extends Error {
	readonly operation: string;
	readonly code: string;
	readonly relativePath: string;

	constructor(operation: string, code: string, relativePath: string, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkspaceFsError";
		this.operation = operation;
		this.code = code;
		this.relativePath = relativePath;
	}
}

export function validateWorkspaceRelativePath(
	relativePath: string,
	options?: { allowRoot?: boolean; operation?: string },
): string {
	const operation = options?.operation ?? "validate";
	if (relativePath === ".") {
		if (options?.allowRoot) return relativePath;
		throw new WorkspaceFsError(operation, "EINVAL", relativePath, "The workspace root is not a valid target");
	}
	if (
		relativePath.length === 0 ||
		relativePath.startsWith("/") ||
		relativePath.endsWith("/") ||
		relativePath.includes("//") ||
		relativePath.includes("\\") ||
		relativePath.includes("\0")
	) {
		throw new WorkspaceFsError(
			operation,
			"EINVAL",
			relativePath,
			"Workspace paths must be normalized, portable, and relative",
		);
	}
	for (const component of relativePath.split("/")) {
		if (component === "." || component === ".." || component.includes(":")) {
			throw new WorkspaceFsError(
				operation,
				"EINVAL",
				relativePath,
				"Workspace paths must not contain traversing or non-portable components",
			);
		}
	}
	return relativePath;
}

function metadataFromNative(metadata: NativeMetadata): WorkspaceMetadata {
	return {
		type: metadata.fileType,
		size: metadata.size,
		modifiedMs: metadata.modifiedMs,
		...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
	};
}

function directoryEntryFromNative(entry: NativeDirectoryEntry): WorkspaceDirectoryEntry {
	return { name: entry.name, type: entry.fileType };
}

function nativeErrorCode(error: unknown): string {
	if (!(error instanceof Error)) return "EIO";
	return /\[([A-Z][A-Z0-9_]*)\]/.exec(error.message)?.[1] ?? "EIO";
}

function normalizedError(operation: string, relativePath: string, error: unknown): WorkspaceFsError {
	if (error instanceof WorkspaceFsError) return error;
	if (error instanceof WorkspaceFsNativeUnavailableError) throw error;
	const detail = error instanceof Error ? error.message : String(error);
	return new WorkspaceFsError(
		operation,
		nativeErrorCode(error),
		relativePath,
		`Workspace filesystem ${operation} failed for ${relativePath}: ${detail}`,
		error,
	);
}

export class WorkspaceRoot {
	readonly rootPath: string;
	private readonly native: NativeWorkspaceRoot;

	constructor(rootPath: string) {
		if (!path.isAbsolute(rootPath)) {
			throw new WorkspaceFsError("open", "EINVAL", ".", `Workspace root must be absolute: ${rootPath}`);
		}
		this.rootPath = rootPath;
		try {
			this.native = new (loadWorkspaceFsNativeAddon().WorkspaceRoot)(rootPath);
		} catch (error) {
			throw normalizedError("open", ".", error);
		}
	}

	async lstat(relativePath: string): Promise<WorkspaceMetadata> {
		const validated = validateWorkspaceRelativePath(relativePath, { allowRoot: true, operation: "lstat" });
		try {
			return metadataFromNative(await this.native.lstat(validated));
		} catch (error) {
			throw normalizedError("lstat", validated, error);
		}
	}

	async metadata(relativePath: string): Promise<WorkspaceMetadata> {
		const validated = validateWorkspaceRelativePath(relativePath, { allowRoot: true, operation: "metadata" });
		try {
			return metadataFromNative(await this.native.metadata(validated));
		} catch (error) {
			throw normalizedError("metadata", validated, error);
		}
	}

	async readFile(relativePath: string): Promise<Buffer> {
		const validated = validateWorkspaceRelativePath(relativePath, { operation: "readFile" });
		try {
			return await this.native.readFile(validated);
		} catch (error) {
			throw normalizedError("readFile", validated, error);
		}
	}

	async readDirectory(relativePath: string): Promise<WorkspaceDirectoryEntry[]> {
		const validated = validateWorkspaceRelativePath(relativePath, { allowRoot: true, operation: "readDirectory" });
		try {
			return (await this.native.readDirectory(validated)).map(directoryEntryFromNative);
		} catch (error) {
			throw normalizedError("readDirectory", validated, error);
		}
	}

	async createFile(relativePath: string, data: Uint8Array): Promise<void> {
		const validated = validateWorkspaceRelativePath(relativePath, { operation: "createFile" });
		try {
			await this.native.createFile(validated, Buffer.from(data));
		} catch (error) {
			throw normalizedError("createFile", validated, error);
		}
	}

	async replaceFile(relativePath: string, data: Uint8Array): Promise<void> {
		const validated = validateWorkspaceRelativePath(relativePath, { operation: "replaceFile" });
		try {
			await this.native.replaceFile(validated, Buffer.from(data));
		} catch (error) {
			throw normalizedError("replaceFile", validated, error);
		}
	}

	async rename(oldRelativePath: string, newRelativePath: string, options?: WorkspaceRenameOptions): Promise<void> {
		const oldPath = validateWorkspaceRelativePath(oldRelativePath, { operation: "rename" });
		const newPath = validateWorkspaceRelativePath(newRelativePath, { operation: "rename" });
		try {
			await this.native.rename(oldPath, newPath, options?.overwrite === true);
		} catch (error) {
			throw normalizedError("rename", oldPath, error);
		}
	}

	async remove(relativePath: string, options?: WorkspaceRemoveOptions): Promise<void> {
		const validated = validateWorkspaceRelativePath(relativePath, { operation: "remove" });
		try {
			await this.native.remove(validated, options?.recursive === true);
		} catch (error) {
			throw normalizedError("remove", validated, error);
		}
	}

	close(): void {
		this.native.close();
	}

	async dispose(): Promise<void> {
		this.close();
	}
}
