import type { ExecFileException } from "child_process";
import { execFile, spawn } from "child_process";
import { EventEmitter } from "events";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

type MockClipboardProcess = {
	child: ReturnType<typeof spawn>;
	close: (code?: number | null, signal?: NodeJS.Signals | null) => void;
	input: () => string;
	stdinDestroy: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
	return {
		execFile: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("child_process", () => {
	return {
		execFile: mocks.execFile,
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

const mockedExecFile = vi.mocked(execFile);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let spawnedProcesses: MockClipboardProcess[];

function createMockClipboardProcess(): MockClipboardProcess {
	const childEvents = new EventEmitter();
	const stdinEvents = new EventEmitter();
	let input = "";
	const stdinDestroy = vi.fn();
	const stdin = Object.assign(stdinEvents, {
		destroy: stdinDestroy,
		end: vi.fn((text: string) => {
			input += text;
		}),
	});
	const child = Object.assign(childEvents, {
		stdin,
		kill: vi.fn(() => true),
	}) as unknown as ReturnType<typeof spawn>;

	return {
		child,
		close: (code = 0, signal = null) => childEvents.emit("close", code, signal),
		input: () => input,
		stdinDestroy,
	};
}

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	vi.stubEnv("TERMUX_VERSION", "");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	vi.stubEnv("DISPLAY", "");
	stdoutWrites = [];
	spawnedProcesses = [];
	mocks.execFile.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.execFile.mockImplementation(
		(_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
			queueMicrotask(() => callback(null, "", ""));
		},
	);
	mocks.spawn.mockImplementation(() => {
		const clipboardProcess = createMockClipboardProcess();
		spawnedProcesses.push(clipboardProcess);
		queueMicrotask(() => clipboardProcess.close());
		return clipboardProcess.child;
	});
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
	test("reads Windows text asynchronously without a PowerShell formatting newline", async () => {
		mockedPlatform.mockReturnValue("win32");
		let complete: ExecFileCallback | undefined;
		mocks.execFile.mockImplementation(
			(_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				complete = callback;
			},
		);

		let settled = false;
		const read = readClipboardText();
		void read.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(complete).toBeTypeOf("function");
		complete?.(null, "abc", "");
		await expect(read).resolves.toBe("abc");
		expect(mockedExecFile).toHaveBeenCalledWith(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write((Get-Clipboard -Raw))"],
			{
				encoding: "utf8",
				maxBuffer: 50 * 1024 * 1024,
				timeout: 5000,
			},
			expect.any(Function),
		);
	});

	test("preserves the Linux read fallback order and returned newlines", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("TERMUX_VERSION", "1");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		mocks.execFile.mockImplementation(
			(command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				queueMicrotask(() => {
					if (command === "xsel") callback(null, "fallback\n", "");
					else callback(new Error(`${command} failed`) as ExecFileException, "", "");
				});
			},
		);

		await expect(readClipboardText()).resolves.toBe("fallback\n");
		expect(mockedExecFile.mock.calls.map(([command]) => command)).toEqual([
			"termux-clipboard-get",
			"wl-paste",
			"xclip",
			"xsel",
		]);
	});
});

describe("copyToClipboard", () => {
	test("waits asynchronously for pbcopy and skips OSC 52 after local success", async () => {
		const clipboardProcess = createMockClipboardProcess();
		mocks.spawn.mockReturnValue(clipboardProcess.child);

		let settled = false;
		const copy = copyToClipboard("hello");
		void copy.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(mockedSpawn).toHaveBeenCalledWith("pbcopy", [], {
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(clipboardProcess.input()).toBe("hello");
		clipboardProcess.close();
		await expect(copy).resolves.toBeUndefined();
		expect(osc52Writes()).toHaveLength(0);
	});

	test("remote macOS success writes pbcopy and OSC 52", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");

		await copyToClipboard("hello");

		expect(mockedSpawn).toHaveBeenCalledWith("pbcopy", [], expect.any(Object));
		expect(spawnedProcesses[0]?.input()).toBe("hello");
		expect(osc52Writes()).toHaveLength(1);
	});

	test("runs the Wayland probe asynchronously before writing", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		let completeProbe: ExecFileCallback | undefined;
		mocks.execFile.mockImplementation(
			(_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				completeProbe = callback;
			},
		);

		let settled = false;
		const copy = copyToClipboard("hello");
		void copy.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(mockedExecFile).toHaveBeenCalledWith(
			"which",
			["wl-copy"],
			expect.objectContaining({ timeout: 5000 }),
			expect.any(Function),
		);
		expect(mockedSpawn).not.toHaveBeenCalled();
		completeProbe?.(null, "/usr/bin/wl-copy\n", "");
		await expect(copy).resolves.toBeUndefined();
		expect(mockedSpawn).toHaveBeenCalledWith("wl-copy", [], expect.any(Object));
		expect(spawnedProcesses[0]?.input()).toBe("hello");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("preserves Termux, Wayland, and X11 writer fallback order", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("TERMUX_VERSION", "1");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.isWaylandSession.mockReturnValue(true);
		mocks.spawn.mockImplementation((command: string) => {
			const clipboardProcess = createMockClipboardProcess();
			spawnedProcesses.push(clipboardProcess);
			queueMicrotask(() => clipboardProcess.close(command === "xsel" ? 0 : 1));
			return clipboardProcess.child;
		});

		await copyToClipboard("hello");

		expect(mockedExecFile.mock.calls.map(([command]) => command)).toEqual(["which"]);
		expect(mockedSpawn.mock.calls.map(([command]) => command)).toEqual([
			"termux-clipboard-set",
			"wl-copy",
			"xclip",
			"xsel",
		]);
		expect(spawnedProcesses.map((clipboardProcess) => clipboardProcess.input())).toEqual([
			"hello",
			"hello",
			"hello",
			"hello",
		]);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("cleans up a timed-out writer and uses OSC 52 fallback", async () => {
		const clipboardProcess = createMockClipboardProcess();
		mocks.spawn.mockReturnValue(clipboardProcess.child);
		const copy = copyToClipboard("hello");

		clipboardProcess.close(null, "SIGTERM");
		await expect(copy).resolves.toBeUndefined();

		expect(clipboardProcess.stdinDestroy).toHaveBeenCalledOnce();
		expect(clipboardProcess.child.listenerCount("error")).toBe(0);
		expect(clipboardProcess.child.listenerCount("close")).toBe(0);
		expect(osc52Writes()).toHaveLength(1);
	});

	test("uses OSC 52 fallback when native tools fail", async () => {
		mocks.spawn.mockImplementation(() => {
			const clipboardProcess = createMockClipboardProcess();
			queueMicrotask(() => clipboardProcess.close(1));
			return clipboardProcess.child;
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.spawn.mockImplementation(() => {
			const clipboardProcess = createMockClipboardProcess();
			queueMicrotask(() => clipboardProcess.close(1));
			return clipboardProcess.child;
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
