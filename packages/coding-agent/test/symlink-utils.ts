import { symlinkSync } from "node:fs";
import { symlink } from "node:fs/promises";

type SymlinkType = "dir" | "file" | "junction";

function isSymlinkPermissionError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
}

export function directorySymlinkType(): SymlinkType {
	return process.platform === "win32" ? "junction" : "dir";
}

export function createDirectorySymlinkSync(target: string, path: string): void {
	symlinkSync(target, path, directorySymlinkType());
}

export function tryCreateFileSymlinkSync(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, "file");
		return true;
	} catch (error) {
		if (isSymlinkPermissionError(error)) return false;
		throw error;
	}
}

export async function tryCreateFileSymlink(target: string, path: string): Promise<boolean> {
	try {
		await symlink(target, path, "file");
		return true;
	} catch (error) {
		if (isSymlinkPermissionError(error)) return false;
		throw error;
	}
}
