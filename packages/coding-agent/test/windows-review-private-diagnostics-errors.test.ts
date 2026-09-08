import { Buffer } from "node:buffer";
import type { ExecFileException, ExecFileOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

type Completion = (error: ExecFileException | null, stdout: string, stderr: string) => void;
const processMocks = vi.hoisted(() => ({
	execFile:
		vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: Completion) => { stdin: Writable }>(),
}));
vi.mock("node:child_process", () => ({ execFile: processMocks.execFile }));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	processMocks.execFile.mockReset();
});

describe("Windows diagnostic subprocess failure containment", () => {
	it.each(["timeout", "permission failure", "early pipe closure"])(
		"sanitizes %s and bounds subprocess work",
		async (failure) => {
			const systemRoot = join(tmpdir(), "windows-system-fixture");
			vi.stubEnv("SystemRoot", systemRoot);
			const path = join(tmpdir(), "private-path-marker", "review.jsonl");
			const content = "private-content-marker\n$(throw 'not code'); 界";
			const input = new PassThrough();
			const inputChunks: Buffer[] = [];
			input.on("data", (chunk: Buffer) => inputChunks.push(chunk));
			let completion: Completion | undefined;
			processMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
				completion = callback;
				return { stdin: input };
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const pending = writeWindowsReviewDiagnostic(path, content);
			const rejection = expect(pending).rejects.toThrow(/^Could not retain private Windows review diagnostics\.$/);
			const invocation = processMocks.execFile.mock.calls[0];
			if (!invocation || !completion) throw new Error("Expected a diagnostic subprocess");
			expect(invocation[0]).toBe(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
			expect(invocation[2]).toEqual({ windowsHide: true, timeout: 10_000, maxBuffer: 8_192 });
			expect(invocation[1].slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
			const executedScript = Buffer.from(invocation[1].at(-1)!, "base64").toString("utf16le");
			expect(executedScript).not.toContain("private-path-marker");
			expect(executedScript).not.toContain("private-content-marker");
			expect(JSON.parse(Buffer.concat(inputChunks).toString("utf8"))).toEqual({
				directory: dirname(path),
				path,
				content,
			});
			if (failure === "early pipe closure") {
				expect(() => input.emit("error", new Error(`EPIPE ${path} ${content}`))).not.toThrow();
			}
			const error: ExecFileException = Object.assign(new Error(`${path}: ${content}`), {
				code: failure === "timeout" ? "ETIMEDOUT" : "EACCES",
				...(failure === "timeout" ? { killed: true, signal: "SIGTERM" as const } : {}),
			});
			completion(error, "private stdout", "private stderr");
			await rejection;
			expect(processMocks.execFile).toHaveBeenCalledOnce();
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it("refuses to search PATH when the Windows system directory is unavailable", async () => {
		vi.stubEnv("SystemRoot", undefined);
		await expect(writeWindowsReviewDiagnostic(join(tmpdir(), "private.jsonl"), "private")).rejects.toThrow(
			"Windows system directory is unavailable.",
		);
		expect(processMocks.execFile).not.toHaveBeenCalled();
	});
});
