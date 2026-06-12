/**
 * Config-driven multi-server LSP manager.
 *
 * Routes files to language servers by extension, lazily spawns one client per
 * (server, project root), and formats post-mutation diagnostics for tool
 * results. Server start failures are reported once and then suppressed.
 */

import { existsSync } from "node:fs";
import { rename as fsRename, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDiagnosticsProvider } from "../tools/diagnostics-provider.ts";
import { withFileMutationQueue } from "../tools/file-mutation-queue.ts";
import type { LspNavigationProvider } from "../tools/lsp.ts";
import { LspClient, type LspDiagnostic, type LspPosition, type LspRange } from "./client.ts";
import { type ResolvedLspConfig, type ResolvedLspServerConfig, SEVERITY_NAMES } from "./config.ts";
import { applyTextEdits, type LspWorkspaceEdit, normalizeWorkspaceEdit } from "./workspace-edit.ts";

export interface LspManagerOptions {
	cwd: string;
	config: ResolvedLspConfig;
}

export interface LspServerStatus {
	name: string;
	root: string;
	alive: boolean;
	openDocuments: number;
	/** Milliseconds since the server was last used */
	idleMs: number;
}

interface ServerFailureState {
	count: number;
	reported: boolean;
}

const MAX_START_ATTEMPTS = 3;
const MAX_REFERENCES = 50;
const MAX_SYMBOL_LINES = 200;

function uriToPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type parameter",
};

interface LspLocation {
	uri: string;
	range: LspRange;
}

interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
}

interface LspDocumentSymbol {
	name: string;
	kind: number;
	selectionRange?: LspRange;
	location?: { range: LspRange };
	children?: LspDocumentSymbol[];
}

interface LspHoverResult {
	contents: unknown;
}

interface LspCommand {
	title?: string;
	command: string;
	arguments?: unknown[];
}

interface LspCodeAction {
	title: string;
	kind?: string;
	edit?: LspWorkspaceEdit;
	command?: LspCommand;
}

interface NormalizedCodeAction {
	title: string;
	kind?: string;
	edit?: LspWorkspaceEdit;
	command?: LspCommand;
	/** Raw action payload, used for codeAction/resolve */
	raw: unknown;
}

function positionLeq(a: LspPosition, b: LspPosition): boolean {
	return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function rangesOverlap(a: LspRange, b: LspRange): boolean {
	return positionLeq(a.start, b.end) && positionLeq(b.start, a.end);
}

/** Normalize codeAction results: bare Commands and CodeAction literals. */
function normalizeCodeActions(result: unknown): NormalizedCodeAction[] {
	if (!Array.isArray(result)) {
		return [];
	}
	const actions: NormalizedCodeAction[] = [];
	for (const item of result) {
		if (!item || typeof item !== "object" || typeof (item as { title?: unknown }).title !== "string") {
			continue;
		}
		const entry = item as LspCodeAction & { command?: LspCommand | string };
		if (typeof entry.command === "string") {
			// Bare Command shape.
			actions.push({ title: entry.title, command: entry as unknown as LspCommand, raw: item });
		} else {
			actions.push({ title: entry.title, kind: entry.kind, edit: entry.edit, command: entry.command, raw: item });
		}
	}
	return actions;
}

type DocumentSession = { error: string } | { client: LspClient; uri: string; content: string };

/** Normalize definition results: Location | Location[] | LocationLink[] | null. */
function normalizeLocations(result: unknown): LspLocation[] {
	if (!result) {
		return [];
	}
	const items = Array.isArray(result) ? result : [result];
	const locations: LspLocation[] = [];
	for (const item of items) {
		const location = item as Partial<LspLocation> & Partial<LspLocationLink>;
		if (typeof location.uri === "string" && location.range) {
			locations.push({ uri: location.uri, range: location.range });
		} else if (typeof location.targetUri === "string") {
			const range = location.targetSelectionRange ?? location.targetRange;
			if (range) {
				locations.push({ uri: location.targetUri, range });
			}
		}
	}
	return locations;
}

/** Extract plain text from LSP hover contents (string | MarkedString[] | MarkupContent). */
function hoverContentsToText(contents: unknown): string {
	if (typeof contents === "string") {
		return contents;
	}
	if (Array.isArray(contents)) {
		return contents
			.map((entry) => hoverContentsToText(entry))
			.filter((text) => text.length > 0)
			.join("\n\n");
	}
	if (contents && typeof contents === "object" && "value" in contents) {
		const value = (contents as { value: unknown }).value;
		return typeof value === "string" ? value : "";
	}
	return "";
}

/**
 * Locate a symbol occurrence in document text.
 *
 * Prefers a word-boundary match on the hinted line, then a word-boundary match
 * anywhere in the file, then plain substring matches.
 */
function findSymbolPosition(content: string, symbol: string, line?: number): LspPosition | undefined {
	const lines = content.split("\n");
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordPattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);

	const searchLine = (index: number): LspPosition | undefined => {
		const text = lines[index];
		if (text === undefined) {
			return undefined;
		}
		const wordMatch = wordPattern.exec(text);
		if (wordMatch) {
			return { line: index, character: wordMatch.index };
		}
		const plainIndex = text.indexOf(symbol);
		return plainIndex === -1 ? undefined : { line: index, character: plainIndex };
	};

	if (line !== undefined && line >= 1 && line <= lines.length) {
		const position = searchLine(line - 1);
		if (position) {
			return position;
		}
	}
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index];
		const wordMatch = wordPattern.exec(text);
		if (wordMatch) {
			return { line: index, character: wordMatch.index };
		}
	}
	for (let index = 0; index < lines.length; index++) {
		const plainIndex = lines[index].indexOf(symbol);
		if (plainIndex !== -1) {
			return { line: index, character: plainIndex };
		}
	}
	return undefined;
}

export class LspManager implements ToolDiagnosticsProvider, LspNavigationProvider {
	private cwd: string;
	private config: ResolvedLspConfig;
	private clients = new Map<string, LspClient>();
	private startFailures = new Map<string, ServerFailureState>();
	private disposed = false;
	/** Summaries of WorkspaceEdits applied via server-initiated workspace/applyEdit */
	private serverApplyEditSummaries: string[] = [];
	private lastUsedAt = new Map<string, number>();
	private idleTimer: NodeJS.Timeout | undefined;

	constructor(options: LspManagerOptions) {
		this.cwd = options.cwd;
		this.config = options.config;
		if (this.config.idleShutdownMs > 0) {
			const checkIntervalMs = Math.max(250, Math.min(this.config.idleShutdownMs / 2, 60000));
			this.idleTimer = setInterval(() => this.shutdownIdleClients(), checkIntervalMs);
			this.idleTimer.unref();
		}
	}

	/** Status of all spawned language servers. */
	getStatus(): LspServerStatus[] {
		const now = Date.now();
		return [...this.clients.entries()].map(([key, client]) => {
			const [name, root] = key.split("\u0000");
			return {
				name,
				root,
				alive: client.isAlive,
				openDocuments: client.openDocumentCount,
				idleMs: now - (this.lastUsedAt.get(key) ?? now),
			};
		});
	}

	/** Dispose all running servers. They respawn lazily on next use. Returns the number stopped. */
	restart(): number {
		const count = this.clients.size;
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.lastUsedAt.clear();
		this.startFailures.clear();
		return count;
	}

	private shutdownIdleClients(): void {
		if (this.disposed) {
			return;
		}
		const now = Date.now();
		for (const [key, client] of [...this.clients.entries()]) {
			const lastUsed = this.lastUsedAt.get(key) ?? now;
			if (now - lastUsed >= this.config.idleShutdownMs) {
				client.dispose();
				this.clients.delete(key);
				this.lastUsedAt.delete(key);
			}
		}
	}

	/**
	 * Collect diagnostics for a file that was just written.
	 *
	 * Returns formatted diagnostics text, or undefined when no matching server
	 * is configured, the server is unavailable, or there is nothing to report.
	 */
	async getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<string | undefined> {
		if (this.disposed) {
			return undefined;
		}
		const server = this.findServer(absolutePath);
		if (!server) {
			return undefined;
		}
		const failure = this.startFailures.get(server.name);
		if (failure && failure.count >= MAX_START_ATTEMPTS) {
			return undefined;
		}

		const client = this.getClient(server, absolutePath);
		let diagnostics: LspDiagnostic[];
		try {
			diagnostics = await client.getDiagnostics(
				absolutePath,
				content,
				this.config.settleMs,
				this.config.firstSettleMs,
				signal,
			);
		} catch (error) {
			return this.handleClientError(server, client, error);
		}
		if (this.disposed) {
			return undefined;
		}
		this.startFailures.delete(server.name);
		return this.formatDiagnostics(absolutePath, diagnostics);
	}

	dispose(): void {
		this.disposed = true;
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = undefined;
		}
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.lastUsedAt.clear();
	}

	// =========================================================================
	// Navigation (LspNavigationProvider)
	// =========================================================================

	async definition(absolutePath: string, symbol: string, line?: number, _signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/definition", "definition", absolutePath, symbol, line);
	}

	async references(absolutePath: string, symbol: string, line?: number, _signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/references", "references", absolutePath, symbol, line);
	}

	async hover(absolutePath: string, symbol: string, line?: number, _signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const result = (await session.client.sendRequest("textDocument/hover", {
				textDocument: { uri: session.uri },
				position,
			})) as LspHoverResult | null;
			const text = result ? hoverContentsToText(result.contents).trim() : "";
			return text.length > 0 ? text : `No hover information for "${symbol}".`;
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async documentSymbols(absolutePath: string, _signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest("textDocument/documentSymbol", {
				textDocument: { uri: session.uri },
			})) as LspDocumentSymbol[] | null;
			if (!result || result.length === 0) {
				return `No symbols found in ${this.displayPath(absolutePath)}.`;
			}
			const lines: string[] = [];
			this.appendSymbolLines(result, 0, lines);
			if (lines.length > MAX_SYMBOL_LINES) {
				const extra = lines.length - MAX_SYMBOL_LINES;
				return [...lines.slice(0, MAX_SYMBOL_LINES), `... and ${extra} more`].join("\n");
			}
			return lines.join("\n");
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async workspaceSymbols(absolutePath: string, query: string, _signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest("workspace/symbol", { query })) as Array<{
				name: string;
				kind: number;
				containerName?: string;
				location?: { uri: string; range?: LspRange };
			}> | null;
			if (!result || result.length === 0) {
				return `No workspace symbols matching "${query}".`;
			}
			const shown = result.slice(0, MAX_REFERENCES);
			const lines = shown.map((symbol) => {
				const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
				const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
				let location = "";
				if (symbol.location?.uri) {
					const path = this.displayPath(uriToPath(symbol.location.uri));
					const line = symbol.location.range ? `:${symbol.location.range.start.line + 1}` : "";
					location = ` ${path}${line}`;
				}
				return `${symbol.name} (${kind})${container}${location}`;
			});
			if (result.length > shown.length) {
				lines.push(`... and ${result.length - shown.length} more`);
			}
			return lines.join("\n");
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async fileDiagnostics(absolutePath: string, signal?: AbortSignal): Promise<string> {
		const server = this.findServer(absolutePath);
		if (!server) {
			return this.noServerMessage(absolutePath);
		}
		let content: string;
		try {
			content = await readFile(absolutePath, "utf-8");
		} catch (error) {
			return `Could not read ${this.displayPath(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`;
		}
		const client = this.getClient(server, absolutePath);
		try {
			const diagnostics = await client.getDiagnostics(
				absolutePath,
				content,
				this.config.settleMs,
				this.config.firstSettleMs,
				signal,
			);
			return (
				this.formatDiagnostics(absolutePath, diagnostics) ?? `No diagnostics in ${this.displayPath(absolutePath)}.`
			);
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	private async locationQuery(
		method: string,
		label: string,
		absolutePath: string,
		symbol: string,
		line?: number,
	): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const result = await session.client.sendRequest(method, {
				textDocument: { uri: session.uri },
				position,
				...(method === "textDocument/references" ? { context: { includeDeclaration: true } } : {}),
			});
			const locations = normalizeLocations(result);
			if (locations.length === 0) {
				return `No ${label} found for "${symbol}".`;
			}
			const shown = locations.slice(0, MAX_REFERENCES);
			const lines = await Promise.all(shown.map((location) => this.formatLocation(location)));
			if (locations.length > shown.length) {
				lines.push(`... and ${locations.length - shown.length} more`);
			}
			return lines.join("\n");
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	/** Route a file to its server, read it from disk, and sync it. Returns an error message on failure. */
	private async openSession(absolutePath: string): Promise<DocumentSession> {
		const server = this.findServer(absolutePath);
		if (!server) {
			return { error: this.noServerMessage(absolutePath) };
		}
		const failure = this.startFailures.get(server.name);
		if (failure && failure.count >= MAX_START_ATTEMPTS) {
			return { error: `lsp(${server.name}): server unavailable after ${failure.count} failed starts.` };
		}
		let content: string;
		try {
			content = await readFile(absolutePath, "utf-8");
		} catch (error) {
			return {
				error: `Could not read ${this.displayPath(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const client = this.getClient(server, absolutePath);
		try {
			const uri = await client.openDocument(absolutePath, content);
			await this.refreshStale(client, absolutePath);
			this.startFailures.delete(server.name);
			return { client, uri, content };
		} catch (error) {
			const reported = this.handleClientError(server, client, error);
			return {
				error: reported ?? `lsp(${server.name}): ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async rename(
		absolutePath: string,
		symbol: string,
		newName: string,
		line?: number,
		_signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const result = (await session.client.sendRequest("textDocument/rename", {
				textDocument: { uri: session.uri },
				position,
				newName,
			})) as LspWorkspaceEdit | null;
			if (!result || normalizeWorkspaceEdit(result).length === 0) {
				return `Rename of "${symbol}" is not available at this position.`;
			}
			const { summary } = await this.applyWorkspaceEdit(session.client, result);
			return `Renamed "${symbol}" to "${newName}":\n${summary}`;
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async codeFix(
		absolutePath: string,
		options: { symbol?: string; line?: number; title?: string },
		_signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath);
		if ("error" in session) {
			return session.error;
		}
		const contentLines = session.content.split("\n");
		let range: LspRange;
		if (options.symbol) {
			const position = findSymbolPosition(session.content, options.symbol, options.line);
			if (!position) {
				return `Symbol "${options.symbol}" not found in ${this.displayPath(absolutePath)}.`;
			}
			range = {
				start: position,
				end: { line: position.line, character: position.character + options.symbol.length },
			};
		} else if (options.line !== undefined && options.line >= 1 && options.line <= contentLines.length) {
			const lineIndex = options.line - 1;
			range = {
				start: { line: lineIndex, character: 0 },
				end: { line: lineIndex, character: contentLines[lineIndex].length },
			};
		} else {
			range = {
				start: { line: 0, character: 0 },
				end: {
					line: Math.max(0, contentLines.length - 1),
					character: contentLines[contentLines.length - 1]?.length ?? 0,
				},
			};
		}

		// Servers derive quick fixes from the diagnostics passed in the context,
		// so make sure we have them before asking for code actions.
		let published = session.client.getPublishedDiagnostics(absolutePath);
		if (published.length === 0) {
			try {
				published = await session.client.getDiagnostics(
					absolutePath,
					session.content,
					this.config.settleMs,
					this.config.firstSettleMs,
					_signal,
				);
			} catch {
				// Code actions may still be available without diagnostics context.
			}
		}
		const diagnostics = published.filter((diagnostic) => rangesOverlap(diagnostic.range, range));
		try {
			const result = await session.client.sendRequest("textDocument/codeAction", {
				textDocument: { uri: session.uri },
				range,
				context: { diagnostics },
			});
			const actions = normalizeCodeActions(result);
			if (actions.length === 0) {
				return "No code actions available at this position.";
			}
			const describe = (action: NormalizedCodeAction): string =>
				`- ${action.title}${action.kind ? ` (${action.kind})` : ""}`;
			let chosen: NormalizedCodeAction | undefined;
			if (options.title) {
				const wanted = options.title.toLowerCase();
				chosen =
					actions.find((action) => action.title.toLowerCase() === wanted) ??
					actions.find((action) => action.title.toLowerCase().includes(wanted));
				if (!chosen) {
					return `No code action matching "${options.title}". Available:\n${actions.map(describe).join("\n")}`;
				}
			} else if (actions.length === 1) {
				chosen = actions[0];
			} else {
				return `Multiple code actions available; rerun with a title to apply one:\n${actions.map(describe).join("\n")}`;
			}
			return await this.applyCodeAction(session.client, chosen);
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	private async applyCodeAction(client: LspClient, action: NormalizedCodeAction): Promise<string> {
		let edit = action.edit;
		if (!edit) {
			// Servers may defer the edit to codeAction/resolve.
			try {
				const resolved = (await client.sendRequest("codeAction/resolve", action.raw)) as {
					edit?: LspWorkspaceEdit;
				} | null;
				edit = resolved?.edit;
			} catch {
				// Fall back to the command below.
			}
		}
		if (edit && normalizeWorkspaceEdit(edit).length > 0) {
			const { summary } = await this.applyWorkspaceEdit(client, edit);
			return `Applied "${action.title}":\n${summary}`;
		}
		if (action.command) {
			// Command-based actions apply their edits via workspace/applyEdit.
			this.serverApplyEditSummaries = [];
			await client.sendRequest("workspace/executeCommand", {
				command: action.command.command,
				arguments: action.command.arguments ?? [],
			});
			const summaries = this.serverApplyEditSummaries;
			this.serverApplyEditSummaries = [];
			if (summaries.length > 0) {
				return `Applied "${action.title}":\n${summaries.join("\n")}`;
			}
			return `Executed "${action.title}" (no workspace edits reported).`;
		}
		return `Code action "${action.title}" produced no edits.`;
	}

	/**
	 * Apply a WorkspaceEdit to disk, re-sync open documents, and notify the
	 * server about files it does not have open.
	 */
	private async applyWorkspaceEdit(
		client: LspClient,
		edit: LspWorkspaceEdit,
	): Promise<{ summary: string; changedPaths: string[] }> {
		const operations = normalizeWorkspaceEdit(edit);
		const lines: string[] = [];
		const changedPaths: string[] = [];
		for (const operation of operations) {
			if (operation.kind === "edit") {
				const path = uriToPath(operation.uri);
				await withFileMutationQueue(path, async () => {
					const content = await readFile(path, "utf-8").catch(() => "");
					await writeFile(path, applyTextEdits(content, operation.edits), "utf-8");
				});
				changedPaths.push(path);
				lines.push(
					`${this.displayPath(path)} (${operation.edits.length} edit${operation.edits.length === 1 ? "" : "s"})`,
				);
			} else if (operation.kind === "create") {
				const path = uriToPath(operation.uri);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, "", { flag: "a" });
				changedPaths.push(path);
				lines.push(`created ${this.displayPath(path)}`);
			} else if (operation.kind === "rename") {
				const oldPath = uriToPath(operation.oldUri);
				const newPath = uriToPath(operation.newUri);
				await mkdir(dirname(newPath), { recursive: true });
				await fsRename(oldPath, newPath);
				changedPaths.push(newPath);
				lines.push(`renamed ${this.displayPath(oldPath)} -> ${this.displayPath(newPath)}`);
			} else {
				const path = uriToPath(operation.uri);
				await rm(path, { force: true });
				lines.push(`deleted ${this.displayPath(path)}`);
			}
		}

		const unopenedPaths: string[] = [];
		for (const path of changedPaths) {
			if (client.isDocumentOpen(path)) {
				const content = await readFile(path, "utf-8").catch(() => undefined);
				if (content !== undefined) {
					await client.openDocument(path, content);
				}
			} else {
				unopenedPaths.push(path);
			}
		}
		client.notifyFilesChanged(unopenedPaths);
		return { summary: lines.join("\n"), changedPaths };
	}

	/** Re-sync open documents that changed on disk outside edit/write (best-effort). */
	private async refreshStale(client: LspClient, excludePath: string): Promise<void> {
		try {
			await client.refreshStaleDocuments(excludePath);
		} catch {
			// Staleness refresh must never fail the operation that triggered it.
		}
	}

	private appendSymbolLines(symbols: LspDocumentSymbol[], depth: number, lines: string[]): void {
		for (const symbol of symbols) {
			const range = symbol.selectionRange ?? symbol.location?.range;
			const line = range ? `:${range.start.line + 1}` : "";
			const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
			lines.push(`${"  ".repeat(depth)}${symbol.name} (${kind})${line}`);
			if (symbol.children && symbol.children.length > 0) {
				this.appendSymbolLines(symbol.children, depth + 1, lines);
			}
		}
	}

	private async formatLocation(location: LspLocation): Promise<string> {
		const path = uriToPath(location.uri);
		const line = location.range.start.line + 1;
		const column = location.range.start.character + 1;
		let snippet = "";
		try {
			const content = await readFile(path, "utf-8");
			const text = content.split("\n")[location.range.start.line]?.trim();
			if (text) {
				snippet = `  ${text}`;
			}
		} catch {
			// Snippets are best-effort.
		}
		return `${this.displayPath(path)}:${line}:${column}${snippet}`;
	}

	private noServerMessage(absolutePath: string): string {
		const ext = extname(absolutePath) || "(no extension)";
		return `No language server configured for ${ext} files. Configure one under lsp.servers in settings.`;
	}

	private describeRequestError(absolutePath: string, error: unknown): string {
		const server = this.findServer(absolutePath);
		const name = server?.name ?? "unknown";
		return `lsp(${name}): ${error instanceof Error ? error.message : String(error)}`;
	}

	private displayPath(absolutePath: string): string {
		const rel = relative(this.cwd, absolutePath);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
	}

	private findServer(absolutePath: string): ResolvedLspServerConfig | undefined {
		const ext = extname(absolutePath).toLowerCase();
		if (!ext) {
			return undefined;
		}
		return this.config.servers.find((server) => server.fileExtensions.includes(ext));
	}

	private findRoot(absolutePath: string, rootMarkers: string[]): string {
		// Markers are priority-ordered: a tsconfig.json anywhere up the tree beats
		// a closer package.json. This keeps monorepo subpackages rooted at the
		// directory that actually carries the language configuration.
		for (const marker of rootMarkers) {
			let dir = dirname(absolutePath);
			while (true) {
				if (existsSync(join(dir, marker))) {
					return dir;
				}
				const parent = dirname(dir);
				if (parent === dir) {
					break;
				}
				dir = parent;
			}
		}
		const rel = relative(this.cwd, absolutePath);
		const isUnderCwd = rel !== "" && !rel.startsWith("..") && !rel.includes(":");
		return isUnderCwd ? this.cwd : dirname(absolutePath);
	}

	private getClient(server: ResolvedLspServerConfig, absolutePath: string): LspClient {
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = `${server.name}\u0000${root}`;
		this.lastUsedAt.set(key, Date.now());
		const existing = this.clients.get(key);
		if (existing?.isAlive) {
			return existing;
		}
		existing?.dispose();
		let clientRef!: LspClient;
		const client = new LspClient({
			serverName: server.name,
			command: server.command,
			rootDir: root,
			initializationOptions: server.initializationOptions,
			settings: server.settings,
			onApplyEdit: async (edit) => {
				const { summary } = await this.applyWorkspaceEdit(clientRef, edit as LspWorkspaceEdit);
				this.serverApplyEditSummaries.push(summary);
				return true;
			},
		});
		clientRef = client;
		this.clients.set(key, client);
		return client;
	}

	private handleClientError(server: ResolvedLspServerConfig, client: LspClient, error: unknown): string | undefined {
		if (!client.isAlive) {
			for (const [key, value] of this.clients) {
				if (value === client) {
					this.clients.delete(key);
					this.lastUsedAt.delete(key);
				}
			}
			client.dispose();
		}
		const failure = this.startFailures.get(server.name) ?? { count: 0, reported: false };
		failure.count++;
		this.startFailures.set(server.name, failure);
		if (this.disposed || failure.reported) {
			return undefined;
		}
		failure.reported = true;
		const message = error instanceof Error ? error.message : String(error);
		return `lsp(${server.name}): ${message} (further failures for this server will be silent)`;
	}

	private formatDiagnostics(absolutePath: string, diagnostics: LspDiagnostic[]): string | undefined {
		const filtered = diagnostics
			.filter((diagnostic) => (diagnostic.severity ?? 1) <= this.config.maxSeverity)
			.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
		if (filtered.length === 0) {
			return undefined;
		}
		const shown = filtered.slice(0, this.config.maxDiagnostics);
		const displayPath = this.displayPath(absolutePath);
		const lines = shown.map((diagnostic) => {
			const severity = SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error";
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const code =
				diagnostic.code !== undefined
					? ` [${diagnostic.source ? `${diagnostic.source} ` : ""}${diagnostic.code}]`
					: "";
			const message = diagnostic.message.replace(/\s+/g, " ").trim();
			return `${displayPath}(${line},${column}): ${severity}: ${message}${code}`;
		});
		if (filtered.length > shown.length) {
			lines.push(`... and ${filtered.length - shown.length} more`);
		}
		return lines.join("\n");
	}
}
