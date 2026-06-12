import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/core/lsp/client.ts";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { applyTextEdits, normalizeWorkspaceEdit } from "../src/core/lsp/workspace-edit.ts";
import type { ToolDiagnosticsProvider } from "../src/core/tools/diagnostics-provider.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createLspToolDefinition, type LspNavigationProvider } from "../src/core/tools/lsp.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const FAKE_SERVER = join(__dirname, "fixtures", "fake-lsp-server.mjs");

/** Remove a temp dir, retrying while a just-killed server process releases it (Windows). */
async function removeTempDir(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	rmSync(dir, { recursive: true, force: true });
}

function fakeServerConfig(options?: {
	pull?: boolean;
	severity?: "error" | "warning";
	maxDiagnostics?: number;
	settleMs?: number;
	firstSettleMs?: number;
	publishDelayMs?: number;
	idleShutdownMs?: number;
}) {
	return resolveLspConfig({
		enabled: true,
		settleMs: options?.settleMs ?? 3000,
		firstSettleMs: options?.firstSettleMs,
		maxDiagnostics: options?.maxDiagnostics,
		severity: options?.severity,
		idleShutdownMs: options?.idleShutdownMs ?? 0,
		servers: {
			// Disable built-in defaults so the test never spawns real servers.
			typescript: { enabled: false },
			python: { enabled: false },
			go: { enabled: false },
			rust: { enabled: false },
			fake: {
				command: [
					process.execPath,
					FAKE_SERVER,
					...(options?.pull ? ["--pull"] : []),
					...(options?.publishDelayMs !== undefined ? ["--delay", String(options.publishDelayMs)] : []),
				],
				fileExtensions: [".foo"],
				rootMarkers: [],
			},
		},
	});
}

describe("resolveLspConfig", () => {
	it("is disabled by default and includes built-in servers", () => {
		const config = resolveLspConfig(undefined);
		expect(config.enabled).toBe(false);
		expect(config.servers.map((s) => s.name)).toContain("typescript");
		expect(config.maxSeverity).toBe(1);
		expect(config.settleMs).toBe(1500);
		expect(config.firstSettleMs).toBe(10000);
	});

	it("merges user overrides over built-in defaults by name", () => {
		const config = resolveLspConfig({
			enabled: true,
			severity: "warning",
			servers: {
				typescript: { command: ["my-ts-server", "--stdio"] },
				rust: { enabled: false },
				custom: { command: ["custom-ls"], fileExtensions: ["zig"], settings: { custom: { level: 3 } } },
			},
		});
		expect(config.enabled).toBe(true);
		expect(config.maxSeverity).toBe(2);
		const typescript = config.servers.find((s) => s.name === "typescript");
		expect(typescript?.command).toEqual(["my-ts-server", "--stdio"]);
		expect(typescript?.fileExtensions).toContain(".ts");
		expect(config.servers.find((s) => s.name === "rust")).toBeUndefined();
		expect(config.servers.find((s) => s.name === "custom")?.fileExtensions).toEqual([".zig"]);
		expect(config.servers.find((s) => s.name === "custom")?.settings).toEqual({ custom: { level: 3 } });
	});

	it("skips user servers without a command or file extensions", () => {
		const config = resolveLspConfig({ servers: { broken: { command: ["x"] } } });
		expect(config.servers.find((s) => s.name === "broken")).toBeUndefined();
	});
});

describe("LspManager", () => {
	let tempDir: string;
	let manager: LspManager | undefined;

	function setup(options?: Parameters<typeof fakeServerConfig>[0]): LspManager {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-test-"));
		manager = new LspManager({ cwd: tempDir, config: fakeServerConfig(options) });
		return manager;
	}

	afterEach(async () => {
		manager?.dispose();
		manager = undefined;
		if (tempDir) {
			await removeTempDir(tempDir);
		}
	});

	it("returns formatted diagnostics from published diagnostics", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		const content = "ok line\nthis has ERROR here\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toBeDefined();
		expect(result).toContain("test.foo(2,10): error: found ERROR on line 2 [fake 1234]");
	});

	it("returns diagnostics via pull diagnostics when the server supports them", async () => {
		const manager = setup({ pull: true });
		const filePath = join(tempDir, "test.foo");
		const content = "ERROR at start\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toContain("error: found ERROR on line 1");
	});

	it("filters diagnostics below the severity threshold", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		const content = "only a WARN here\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toBeUndefined();
	});

	it("includes warnings when severity is set to warning", async () => {
		const manager = setup({ severity: "warning" });
		const filePath = join(tempDir, "test.foo");
		const content = "only a WARN here\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toContain("warning: found WARN on line 1");
	});

	it("caps output at maxDiagnostics", async () => {
		const manager = setup({ maxDiagnostics: 2 });
		const filePath = join(tempDir, "test.foo");
		const content = "ERROR one\nERROR two\nERROR three\nERROR four\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toBeDefined();
		expect(result?.split("\n")).toHaveLength(3);
		expect(result).toContain("... and 2 more");
	});

	it("returns undefined for clean files and files with no matching server", async () => {
		const manager = setup();
		const fooPath = join(tempDir, "clean.foo");
		writeFileSync(fooPath, "all good\n");
		expect(await manager.getDiagnostics(fooPath, "all good\n")).toBeUndefined();
		expect(await manager.getDiagnostics(join(tempDir, "other.bar"), "ERROR\n")).toBeUndefined();
	});

	it("tracks document versions across repeated checks of the same file", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "ok\n");
		expect(await manager.getDiagnostics(filePath, "ok\n")).toBeUndefined();
		const second = await manager.getDiagnostics(filePath, "now ERROR\n");
		expect(second).toContain("error: found ERROR on line 1");
		const third = await manager.getDiagnostics(filePath, "fixed\n");
		expect(third).toBeUndefined();
	});

	it("answers navigation queries via the fake server", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		const content = "class FakeClass\n  fakeMethod here\n";
		writeFileSync(filePath, content);

		const definition = await manager.definition(filePath, "FakeClass");
		expect(definition).toContain("test.foo:1:1");
		expect(definition).toContain("class FakeClass");

		const references = await manager.references(filePath, "fakeMethod", 2);
		const referenceLines = references.split("\n");
		expect(referenceLines).toHaveLength(2);
		expect(referenceLines[0]).toContain("test.foo:1:1");
		expect(referenceLines[1]).toContain("test.foo:2:3");

		const hover = await manager.hover(filePath, "fakeMethod");
		expect(hover).toBe("fake hover text");

		const symbols = await manager.documentSymbols(filePath);
		expect(symbols).toBe("FakeClass (class):1\n  fakeMethod (method):2");

		const diagnostics = await manager.fileDiagnostics(filePath);
		expect(diagnostics).toContain("No diagnostics in");
	});

	it("reports symbol-not-found and no-server errors as text", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "nothing here\n");
		expect(await manager.definition(filePath, "missingSymbol")).toContain('Symbol "missingSymbol" not found');
		expect(await manager.hover(join(tempDir, "test.bar"), "x")).toContain("No language server configured for .bar");
	});

	it("re-waits for diagnostics when a dependency changed on disk", async () => {
		// Regression: the unchanged-content shortcut must not return a stale
		// publish when other open documents were just refreshed from disk.
		const manager = setup();
		const fileA = join(tempDir, "a.foo");
		const fileB = join(tempDir, "b.foo");
		const contentA = "watch CROSS here\n";
		writeFileSync(fileA, contentA);
		writeFileSync(fileB, "fine\n");
		expect(await manager.getDiagnostics(fileA, contentA)).toBeUndefined();
		expect(await manager.getDiagnostics(fileB, "fine\n")).toBeUndefined();

		// Break the dependency outside the edit/write tools.
		writeFileSync(fileB, "now has ERROR\n");
		const result = await manager.getDiagnostics(fileA, contentA);
		expect(result).toContain("cross-file ERROR detected");
	});

	it("waits longer for the first diagnostics from a fresh server", async () => {
		// The publish delay exceeds settleMs but not firstSettleMs, so only the
		// extended first-collection window catches the cold-start publish.
		const manager = setup({ settleMs: 100, firstSettleMs: 5000, publishDelayMs: 800 });
		const filePath = join(tempDir, "test.foo");
		const content = "has ERROR here\n";
		writeFileSync(filePath, content);
		const result = await manager.getDiagnostics(filePath, content);
		expect(result).toContain("error: found ERROR on line 1");
	});

	it("renames a symbol across open files", async () => {
		const manager = setup();
		const fileA = join(tempDir, "a.foo");
		const fileB = join(tempDir, "b.foo");
		writeFileSync(fileA, "function renameme() {}\nrenameme();\n");
		writeFileSync(fileB, "call renameme() twice renameme\n");
		// Open both documents on the server.
		await manager.documentSymbols(fileB);

		const result = await manager.rename(fileA, "renameme", "renamed");
		expect(result).toContain('Renamed "renameme" to "renamed"');
		expect(result).toContain("a.foo (2 edits)");
		expect(result).toContain("b.foo (2 edits)");
		expect(readFileSync(fileA, "utf-8")).toBe("function renamed() {}\nrenamed();\n");
		expect(readFileSync(fileB, "utf-8")).toBe("call renamed() twice renamed\n");
	});

	it("applies a single quick fix automatically", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "this line has ERROR in it\n");
		const result = await manager.codeFix(filePath, { line: 1 });
		expect(result).toContain('Applied "Replace ERROR with FIXED"');
		expect(result).toContain("test.foo (1 edit)");
		expect(readFileSync(filePath, "utf-8")).toBe("this line has FIXED in it\n");
	});

	it("lists multiple code actions and applies the chosen title", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		const content = "has ERROR and MULTI here\n";
		writeFileSync(filePath, content);

		const listed = await manager.codeFix(filePath, { line: 1 });
		expect(listed).toContain("Multiple code actions available");
		expect(listed).toContain("- Replace ERROR with FIXED (quickfix)");
		expect(listed).toContain("- Replace MULTI with CHOSEN (refactor)");
		expect(readFileSync(filePath, "utf-8")).toBe(content);

		const applied = await manager.codeFix(filePath, { line: 1, title: "MULTI" });
		expect(applied).toContain('Applied "Replace MULTI with CHOSEN"');
		expect(readFileSync(filePath, "utf-8")).toBe("has ERROR and CHOSEN here\n");
	});

	it("applies command-based code actions via workspace/applyEdit", async () => {
		const manager = setup();
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "needs CMDFIX here\n");
		const result = await manager.codeFix(filePath, { line: 1 });
		expect(result).toContain('Applied "Fix via command"');
		expect(result).toContain("test.foo (1 edit)");
		expect(readFileSync(filePath, "utf-8")).toBe("needs FIXED here\n");
	});

	it("searches workspace symbols when a query is provided", async () => {
		const manager = setup();
		const fileA = join(tempDir, "a.foo");
		const fileB = join(tempDir, "b.foo");
		writeFileSync(fileA, "has findme here\n");
		writeFileSync(fileB, "\nalso findme there\n");
		// Open both documents so the fake server can search them.
		await manager.documentSymbols(fileA);
		await manager.documentSymbols(fileB);

		const result = await manager.workspaceSymbols(fileA, "findme");
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("findme (variable) in fakeContainer a.foo:1");
		expect(lines[1]).toBe("findme (variable) in fakeContainer b.foo:2");

		expect(await manager.workspaceSymbols(fileA, "nomatch")).toContain('No workspace symbols matching "nomatch"');
	});

	it("reports server status and restarts servers", async () => {
		const manager = setup();
		expect(manager.getStatus()).toEqual([]);

		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "ok\n");
		await manager.documentSymbols(filePath);

		const status = manager.getStatus();
		expect(status).toHaveLength(1);
		expect(status[0].name).toBe("fake");
		expect(status[0].root).toBe(tempDir);
		expect(status[0].alive).toBe(true);
		expect(status[0].openDocuments).toBe(1);
		expect(status[0].idleMs).toBeGreaterThanOrEqual(0);

		expect(manager.restart()).toBe(1);
		expect(manager.getStatus()).toEqual([]);

		// Servers respawn lazily after restart.
		await manager.documentSymbols(filePath);
		expect(manager.getStatus()).toHaveLength(1);
	});

	it("shuts down idle servers and respawns on next use", async () => {
		const manager = setup({ idleShutdownMs: 400 });
		const filePath = join(tempDir, "test.foo");
		writeFileSync(filePath, "ok\n");
		await manager.documentSymbols(filePath);
		expect(manager.getStatus()).toHaveLength(1);

		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(manager.getStatus()).toEqual([]);

		const result = await manager.documentSymbols(filePath);
		expect(result).toContain("FakeClass");
		expect(manager.getStatus()).toHaveLength(1);
	});

	it("reports a failed server start once, then stays silent", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-test-"));
		manager = new LspManager({
			cwd: tempDir,
			config: resolveLspConfig({
				enabled: true,
				servers: {
					typescript: { enabled: false },
					python: { enabled: false },
					go: { enabled: false },
					rust: { enabled: false },
					missing: { command: ["volt-test-nonexistent-lsp-server"], fileExtensions: [".foo"] },
				},
			}),
		});
		const filePath = join(tempDir, "test.foo");
		const first = await manager.getDiagnostics(filePath, "ERROR\n");
		expect(first).toContain("lsp(missing):");
		const second = await manager.getDiagnostics(filePath, "ERROR\n");
		expect(second).toBeUndefined();
	});
});

describe("workspace edits", () => {
	it("applies multiple text edits bottom-up", () => {
		const content = "one two\nthree four\nfive\n";
		const result = applyTextEdits(content, [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" },
			{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } }, newText: "FOUR" },
			{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: "inserted " },
		]);
		expect(result).toBe("ONE two\nthree FOUR\ninserted five\n");
	});

	it("applies multi-line range replacements and clamps out-of-range positions", () => {
		const content = "alpha\nbeta\ngamma";
		const replaced = applyTextEdits(content, [
			{ range: { start: { line: 0, character: 2 }, end: { line: 2, character: 3 } }, newText: "-" },
		]);
		expect(replaced).toBe("al-ma");
		const appended = applyTextEdits(content, [
			{ range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } }, newText: "!" },
		]);
		expect(appended).toBe("alpha\nbeta\ngamma!");
	});

	it("normalizes both WorkspaceEdit shapes", () => {
		expect(
			normalizeWorkspaceEdit({
				changes: {
					"file:///a": [
						{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
					],
				},
			}),
		).toEqual([
			{
				kind: "edit",
				uri: "file:///a",
				edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }],
			},
		]);
		expect(
			normalizeWorkspaceEdit({
				documentChanges: [
					{ textDocument: { uri: "file:///a" }, edits: [] },
					{ kind: "create", uri: "file:///b" },
					{ kind: "rename", oldUri: "file:///b", newUri: "file:///c" },
					{ kind: "delete", uri: "file:///c" },
				],
			}),
		).toEqual([
			{ kind: "edit", uri: "file:///a", edits: [] },
			{ kind: "create", uri: "file:///b" },
			{ kind: "rename", oldUri: "file:///b", newUri: "file:///c" },
			{ kind: "delete", uri: "file:///c" },
		]);
	});
});

describe("LspClient disk sync", () => {
	let tempDir: string;
	let client: LspClient | undefined;

	function setupClient(): LspClient {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-client-test-"));
		client = new LspClient({
			serverName: "fake",
			command: [process.execPath, FAKE_SERVER],
			rootDir: tempDir,
		});
		return client;
	}

	afterEach(async () => {
		client?.dispose();
		client = undefined;
		if (tempDir) {
			await removeTempDir(tempDir);
		}
	});

	interface FakeState {
		opens: string[];
		changes: Array<{ uri: string; version: number }>;
		closes: string[];
		watched: Array<{ uri: string; type: number }>;
		configChanges: unknown[];
		configResponses?: unknown[];
	}

	it("sends configuration and answers workspace/configuration section requests", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-client-test-"));
		const settings = { foo: { bar: 42 }, top: "x" };
		client = new LspClient({
			serverName: "fake",
			command: [process.execPath, FAKE_SERVER, "--config"],
			rootDir: tempDir,
			settings,
		});
		await client.start();
		// Give the server's post-initialized configuration round-trip time to land.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const state = (await client.sendRequest("fake/state", {})) as FakeState;
		expect(state.configChanges).toEqual([settings]);
		expect(state.configResponses).toEqual([42, null, settings]);
	});

	it("re-syncs documents that changed on disk and notifies watched files", async () => {
		const client = setupClient();
		const fileA = join(tempDir, "a.foo");
		writeFileSync(fileA, "original\n");
		await client.openDocument(fileA, "original\n");

		// Unchanged on disk: no refresh.
		expect(await client.refreshStaleDocuments()).toEqual([]);

		writeFileSync(fileA, "modified outside the tools\n");
		expect(await client.refreshStaleDocuments()).toEqual([fileA]);

		const state = (await client.sendRequest("fake/state", {})) as FakeState;
		expect(state.opens).toHaveLength(1);
		expect(state.changes).toHaveLength(1);
		expect(state.changes[0].version).toBe(2);
		expect(state.watched).toEqual([{ uri: state.opens[0], type: 2 }]);
	});

	it("closes documents that were deleted on disk", async () => {
		const client = setupClient();
		const fileA = join(tempDir, "a.foo");
		writeFileSync(fileA, "original\n");
		await client.openDocument(fileA, "original\n");

		rmSync(fileA);
		expect(await client.refreshStaleDocuments()).toEqual([fileA]);

		const state = (await client.sendRequest("fake/state", {})) as FakeState;
		expect(state.closes).toHaveLength(1);
		expect(state.watched).toEqual([{ uri: state.closes[0], type: 3 }]);
	});

	it("skips the excluded path and redundant content syncs", async () => {
		const client = setupClient();
		const fileA = join(tempDir, "a.foo");
		const content = "has ERROR\n";
		writeFileSync(fileA, content);

		const first = await client.getDiagnostics(fileA, content, 3000);
		expect(first).toHaveLength(1);

		// Same content again: no didChange, reuses the existing publish.
		const second = await client.getDiagnostics(fileA, content, 3000);
		expect(second).toEqual(first);

		// Excluded path is not refreshed even if it changed on disk.
		writeFileSync(fileA, "different\n");
		expect(await client.refreshStaleDocuments(fileA)).toEqual([]);

		const state = (await client.sendRequest("fake/state", {})) as FakeState;
		expect(state.opens).toHaveLength(1);
		expect(state.changes).toHaveLength(0);
	});
});

describe("tool diagnostics integration", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await removeTempDir(tempDir);
		}
	});

	const stubProvider: ToolDiagnosticsProvider = {
		getDiagnostics: async (_absolutePath, content) =>
			content.includes("ERROR") ? "stub.ts(1,1): error: stub diagnostic" : undefined,
	};

	it("write tool appends diagnostics to result content and details", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-tool-test-"));
		const writeTool = createWriteToolDefinition(tempDir, { diagnosticsProvider: stubProvider });
		const result = await writeTool.execute(
			"t1",
			{ path: "a.ts", content: "has ERROR\n" },
			undefined,
			undefined,
			{} as never,
		);
		const texts = result.content.filter((c) => c.type === "text").map((c) => ("text" in c ? c.text : ""));
		expect(texts.some((t) => t?.includes("Diagnostics:\nstub.ts(1,1): error: stub diagnostic"))).toBe(true);
		expect(result.details?.diagnostics).toBe("stub.ts(1,1): error: stub diagnostic");

		const clean = await writeTool.execute(
			"t2",
			{ path: "b.ts", content: "clean\n" },
			undefined,
			undefined,
			{} as never,
		);
		expect(clean.content).toHaveLength(1);
		expect(clean.details).toBeUndefined();
	});

	it("edit tool appends diagnostics to result content and details", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-tool-test-"));
		const filePath = join(tempDir, "a.ts");
		writeFileSync(filePath, "original\n");
		const editTool = createEditToolDefinition(tempDir, { diagnosticsProvider: stubProvider });
		const result = await editTool.execute(
			"t1",
			{ path: "a.ts", edits: [{ oldText: "original", newText: "now ERROR" }] },
			undefined,
			undefined,
			{} as never,
		);
		const texts = result.content.filter((c) => c.type === "text").map((c) => ("text" in c ? c.text : ""));
		expect(texts.some((t) => t?.includes("Diagnostics:\nstub.ts(1,1): error: stub diagnostic"))).toBe(true);
		expect(result.details?.diagnostics).toBe("stub.ts(1,1): error: stub diagnostic");
	});

	it("lsp tool routes actions to the provider and validates input", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-tool-test-"));
		const calls: string[] = [];
		const navProvider: LspNavigationProvider = {
			definition: async (path, symbol, line) => {
				calls.push(`definition ${path} ${symbol} ${line}`);
				return "def-result";
			},
			references: async () => "ref-result",
			hover: async () => "hover-result",
			documentSymbols: async () => "symbols-result",
			workspaceSymbols: async (path, query) => {
				calls.push(`workspaceSymbols ${path} ${query}`);
				return "workspace-symbols-result";
			},
			fileDiagnostics: async () => "diag-result",
			rename: async (path, symbol, newName) => {
				calls.push(`rename ${path} ${symbol} ${newName}`);
				return "rename-result";
			},
			codeFix: async (path, options) => {
				calls.push(`fix ${path} ${options.line} ${options.title}`);
				return "fix-result";
			},
		};
		const tool = createLspToolDefinition(tempDir, { provider: navProvider });

		const result = await tool.execute(
			"t1",
			{ action: "definition", path: "a.ts", symbol: "foo", line: 12 },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]).toEqual({ type: "text", text: "def-result" });
		expect(result.details).toEqual({ action: "definition" });
		expect(calls[0]).toBe(`definition ${join(tempDir, "a.ts")} foo 12`);

		const symbols = await tool.execute("t2", { action: "symbols", path: "a.ts" }, undefined, undefined, {} as never);
		expect(symbols.content[0]).toEqual({ type: "text", text: "symbols-result" });

		const workspaceSearch = await tool.execute(
			"t2b",
			{ action: "symbols", path: "a.ts", symbol: "findme" },
			undefined,
			undefined,
			{} as never,
		);
		expect(workspaceSearch.content[0]).toEqual({ type: "text", text: "workspace-symbols-result" });
		expect(calls).toContain(`workspaceSymbols ${join(tempDir, "a.ts")} findme`);

		await expect(
			tool.execute("t3", { action: "references", path: "a.ts" }, undefined, undefined, {} as never),
		).rejects.toThrow("lsp references requires a symbol name");

		const renamed = await tool.execute(
			"t4",
			{ action: "rename", path: "a.ts", symbol: "foo", newName: "bar" },
			undefined,
			undefined,
			{} as never,
		);
		expect(renamed.content[0]).toEqual({ type: "text", text: "rename-result" });
		expect(calls).toContain(`rename ${join(tempDir, "a.ts")} foo bar`);

		const fixed = await tool.execute(
			"t5",
			{ action: "fix", path: "a.ts", line: 3, title: "Add import" },
			undefined,
			undefined,
			{} as never,
		);
		expect(fixed.content[0]).toEqual({ type: "text", text: "fix-result" });
		expect(calls).toContain(`fix ${join(tempDir, "a.ts")} 3 Add import`);

		await expect(
			tool.execute("t6", { action: "rename", path: "a.ts", symbol: "foo" }, undefined, undefined, {} as never),
		).rejects.toThrow("lsp rename requires newName");
	});

	it("lsp tool reports when LSP is disabled", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-tool-test-"));
		const tool = createLspToolDefinition(tempDir);
		await expect(
			tool.execute("t1", { action: "symbols", path: "a.ts" }, undefined, undefined, {} as never),
		).rejects.toThrow("LSP is not enabled");
	});

	it("diagnostics provider failures do not fail the write", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-lsp-tool-test-"));
		const throwingProvider: ToolDiagnosticsProvider = {
			getDiagnostics: async () => {
				throw new Error("boom");
			},
		};
		const writeTool = createWriteToolDefinition(tempDir, { diagnosticsProvider: throwingProvider });
		const result = await writeTool.execute("t1", { path: "a.ts", content: "x\n" }, undefined, undefined, {} as never);
		expect(result.content[0].type).toBe("text");
		expect(result.details).toBeUndefined();
	});
});
