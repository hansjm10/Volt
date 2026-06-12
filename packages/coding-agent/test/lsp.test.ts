import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLspConfig } from "../src/core/lsp/config.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
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

function fakeServerConfig(options?: { pull?: boolean; severity?: "error" | "warning"; maxDiagnostics?: number }) {
	return resolveLspConfig({
		enabled: true,
		settleMs: 3000,
		maxDiagnostics: options?.maxDiagnostics,
		severity: options?.severity,
		servers: {
			// Disable built-in defaults so the test never spawns real servers.
			typescript: { enabled: false },
			python: { enabled: false },
			go: { enabled: false },
			rust: { enabled: false },
			fake: {
				command: [process.execPath, FAKE_SERVER, ...(options?.pull ? ["--pull"] : [])],
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
	});

	it("merges user overrides over built-in defaults by name", () => {
		const config = resolveLspConfig({
			enabled: true,
			severity: "warning",
			servers: {
				typescript: { command: ["my-ts-server", "--stdio"] },
				rust: { enabled: false },
				custom: { command: ["custom-ls"], fileExtensions: ["zig"] },
			},
		});
		expect(config.enabled).toBe(true);
		expect(config.maxSeverity).toBe(2);
		const typescript = config.servers.find((s) => s.name === "typescript");
		expect(typescript?.command).toEqual(["my-ts-server", "--stdio"]);
		expect(typescript?.fileExtensions).toContain(".ts");
		expect(config.servers.find((s) => s.name === "rust")).toBeUndefined();
		expect(config.servers.find((s) => s.name === "custom")?.fileExtensions).toEqual([".zig"]);
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
			fileDiagnostics: async () => "diag-result",
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

		await expect(
			tool.execute("t3", { action: "references", path: "a.ts" }, undefined, undefined, {} as never),
		).rejects.toThrow("lsp references requires a symbol name");
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
