import { existsSync, mkdirSync, rmSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/volt-agent-core";
import { afterEach } from "vitest";

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type SymlinkType = "dir" | "file" | "junction";

const tempDirs: string[] = [];

function isSymlinkPermissionError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
}

export async function tryCreateSymlink(target: string, path: string, type?: SymlinkType): Promise<boolean> {
	try {
		await symlink(target, path, type);
		return true;
	} catch (error) {
		if (isSymlinkPermissionError(error)) return false;
		throw error;
	}
}

export function directorySymlinkType(): SymlinkType {
	return process.platform === "win32" ? "junction" : "dir";
}

export function createTempDir(): string {
	const dir = join(tmpdir(), `volt-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

export function getLatestTempDir(): string {
	return tempDirs[tempDirs.length - 1]!;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
