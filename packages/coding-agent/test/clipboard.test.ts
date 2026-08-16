import { execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		execFileSync: vi.fn(),
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("child_process", () => {
	return {
		execFileSync: mocks.execFileSync,
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	mocks.execFileSync.mockReset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("reads Windows text without a PowerShell formatting newline", async () => {
		mockedPlatform.mockReturnValue("win32");
		mockedExecFileSync.mockReturnValue("abc");

		await expect(readClipboardText()).resolves.toBe("abc");
		expect(mockedExecFileSync).toHaveBeenCalledWith(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write((Get-Clipboard -Raw))"],
			{
				encoding: "utf8",
				maxBuffer: 50 * 1024 * 1024,
				timeout: 5000,
			},
		);
	});
});

describe("copyToClipboard", () => {
	test("local macOS success uses pbcopy and skips OSC 52", async () => {
		mockedExecSync.mockReturnValue(Buffer.alloc(0));
		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote macOS success writes pbcopy and OSC 52", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", expect.any(Object));
		expect(osc52Writes()).toHaveLength(1);
	});

	test("local shell success skips OSC 52", async () => {
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
