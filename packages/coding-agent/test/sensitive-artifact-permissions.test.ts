import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { LspTracer } from "../src/core/lsp/trace.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createPrivateTempDirectorySync, writePrivateNewFileSync } from "../src/utils/private-files.ts";

const mode = (filePath: string): number => statSync(filePath).mode & 0o777;

describe.skipIf(process.platform === "win32")("sensitive artifact permissions", () => {
	let root: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "volt-sensitive-artifacts-"));
		cwd = join(root, "workspace");
		mkdirSync(cwd);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps session directories private across create, open, branch, and fork paths", async () => {
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { mode: 0o777 });
		const manager = SessionManager.create(cwd, sessionDir);
		const leafId = manager.appendCustomMessageEntry("test", "secret", true);
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(mode(sessionDir)).toBe(0o700);
		expect(mode(sessionFile!)).toBe(0o600);

		chmodSync(sessionDir, 0o777);
		chmodSync(sessionFile!, 0o666);
		const reopened = SessionManager.open(sessionFile!, sessionDir);
		expect(mode(sessionDir)).toBe(0o700);
		expect(mode(sessionFile!)).toBe(0o600);

		const branchedFile = reopened.createBranchedSession(leafId);
		await reopened.flush();
		expect(branchedFile).toBeDefined();
		expect(mode(branchedFile!)).toBe(0o600);

		const forkDir = join(root, "forks");
		mkdirSync(forkDir, { mode: 0o777 });
		const forked = SessionManager.forkFrom(sessionFile!, cwd, forkDir);
		expect(mode(forkDir)).toBe(0o700);
		expect(mode(forked.getSessionFile()!)).toBe(0o600);
	});

	it("rejects ambiguous corruption after hardening explicit session artifacts", () => {
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { mode: 0o777 });
		const sessionFile = join(sessionDir, "corrupt.jsonl");
		const original = "not json\n";
		writeFileSync(sessionFile, original, { mode: 0o666 });

		expect(() => SessionManager.open(sessionFile, sessionDir)).toThrow(
			"Current session JSONL is malformed at committed line 1",
		);

		expect(mode(sessionDir)).toBe(0o700);
		expect(mode(sessionFile)).toBe(0o600);
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
	});

	it("does not chmod an implicitly derived shared parent when rejecting corruption", () => {
		const sharedDir = join(root, "shared");
		mkdirSync(sharedDir, { mode: 0o777 });
		chmodSync(sharedDir, 0o777);
		const sessionFile = join(sharedDir, "corrupt.jsonl");
		const original = "not json\n";
		writeFileSync(sessionFile, original, { mode: 0o666 });

		expect(() => SessionManager.open(sessionFile)).toThrow("Current session JSONL is malformed at committed line 1");

		expect(mode(sharedDir)).toBe(0o777);
		expect(mode(sessionFile)).toBe(0o600);
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
	});

	it("rejects linked session sources", async () => {
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendCustomMessageEntry("test", "secret", true);
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		const symbolicLink = join(root, "linked-session.jsonl");
		symlinkSync(sessionFile, symbolicLink);
		expect(() => SessionManager.open(symbolicLink)).toThrow("non-regular private file");

		const hardLink = join(root, "hard-linked-session.jsonl");
		linkSync(sessionFile, hardLink);
		expect(() => SessionManager.forkFrom(hardLink, cwd, join(root, "forks"))).toThrow("multiply-linked private file");
	});

	it("writes HTML and JSONL exports privately without following destination symlinks", async () => {
		const manager = SessionManager.create(cwd, join(root, "sessions"));
		manager.appendCustomMessageEntry("test", "secret", true);
		await manager.flush();

		const exportDir = join(root, "exports", "nested");
		const htmlPath = join(exportDir, "session.html");
		await exportSessionToHtml(manager, undefined, htmlPath);
		expect(mode(exportDir)).toBe(0o700);
		expect(mode(htmlPath)).toBe(0o600);

		const victimPath = join(root, "victim.txt");
		writeFileSync(victimPath, "do not replace", { mode: 0o644 });
		const jsonlPath = join(root, "session.jsonl");
		symlinkSync(victimPath, jsonlPath);
		const exporter = { sessionManager: manager } as unknown as AgentSession;
		AgentSession.prototype.exportToJsonl.call(exporter, jsonlPath);

		expect(lstatSync(jsonlPath).isSymbolicLink()).toBe(false);
		expect(mode(jsonlPath)).toBe(0o600);
		expect(readFileSync(victimPath, "utf8")).toBe("do not replace");
		expect(readFileSync(jsonlPath, "utf8")).toContain('"type":"session"');
	});

	it("creates private scratch directories and removes partially written new files on failure", () => {
		const scratchDirectory = createPrivateTempDirectorySync(join(root, "scratch-"));
		expect(mode(scratchDirectory)).toBe(0o700);
		const scratchFile = join(scratchDirectory, "draft.txt");
		writePrivateNewFileSync(scratchFile, "secret");
		expect(mode(scratchFile)).toBe(0o600);

		const failedFile = join(scratchDirectory, "failed.txt");
		expect(() =>
			writePrivateNewFileSync(failedFile, Symbol("invalid") as unknown as NodeJS.ArrayBufferView),
		).toThrow();
		expect(existsSync(failedFile)).toBe(false);
	});

	it("opens LSP traces owner-only and refuses a symlink target", async () => {
		const tracePath = join(root, "trace.log");
		writeFileSync(tracePath, "existing\n", { mode: 0o666 });
		const tracer = new LspTracer(tracePath);
		tracer.log("test", "info", "payload");
		await tracer.flush();
		expect(mode(tracePath)).toBe(0o600);
		expect(readFileSync(tracePath, "utf8")).toContain("payload");
		await tracer.dispose();

		const victimPath = join(root, "trace-victim.log");
		writeFileSync(victimPath, "victim\n", { mode: 0o644 });
		const linkedTracePath = join(root, "linked-trace.log");
		symlinkSync(victimPath, linkedTracePath);
		const linkedTracer = new LspTracer(linkedTracePath);
		linkedTracer.log("test", "info", "must not land");
		await linkedTracer.flush();
		await linkedTracer.dispose();
		expect(readFileSync(victimPath, "utf8")).toBe("victim\n");
		expect(mode(victimPath)).toBe(0o644);
	});
});
