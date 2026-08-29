/**
 * Config-driven multi-server LSP manager.
 *
 * Routes files to language servers by extension, lazily spawns one client per
 * (server, project root), and formats post-mutation diagnostics for tool
 * results. Server start failures are reported once and then suppressed.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getSubprocessEnv } from "../../utils/process-env.ts";
import type { HostInteraction } from "../host-interaction.ts";
import type { ToolDiagnosticsProvider } from "../tools/diagnostics-provider.ts";
import type { LspNavigationProvider } from "../tools/lsp.ts";
import { LspClient, type LspDiagnostic, type LspPosition, type LspRange } from "./client.ts";
import { type LspLaunchDescriptor, type LspLaunchSource, resolveLspLaunch } from "./command-resolver.ts";
import {
	type LspInstallRecipe,
	type ResolvedLspConfig,
	type ResolvedLspServerConfig,
	SEVERITY_NAMES,
} from "./config.ts";
import { LspTracer } from "./trace.ts";
import { type LspWorkspaceEdit, normalizeWorkspaceEdit } from "./workspace-edit.ts";
import {
	applyWorkspaceEdit as applyWorkspaceEditToDisk,
	type WorkspaceEditApplyResult,
	type WorkspaceEditDocumentSnapshot,
} from "./workspace-edit-applier.ts";

export interface LspManagerOptions {
	/** Runtime cwd used only to shorten displayed tool paths. */
	cwd: string;
	/** LSP workspace ceiling and base for commands/traces. Defaults to cwd. */
	projectCwd?: string;
	config: ResolvedLspConfig;
	hostInteraction?: HostInteraction;
	installRunner?: LspInstallRunner;
}

export interface LspInstallCommandOptions {
	cwd: string;
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
}

export interface LspInstallCommandResult {
	exitCode: number | null;
	output: string;
}

export type LspInstallRunner = (
	command: readonly string[],
	options: LspInstallCommandOptions,
) => Promise<LspInstallCommandResult>;

export interface LspServerStatus {
	name: string;
	/** Canonical project boundary shared by every server root. */
	workspaceRoot: string;
	/** Canonical nested root used to initialize this server client. */
	root: string;
	alive: boolean;
	openDocuments: number;
	/** Milliseconds since the server was last used */
	idleMs: number;
	resolvedExecutable?: string;
	unresolvedCommand?: string;
	launchSource: LspLaunchSource;
	attempts: number;
	lastError?: string;
}

interface ServerFailureState {
	count: number;
	reported: boolean;
	lastError: string;
}

type LspClientErrorResult = { retry: true } | { retry: false; message?: string };

interface LspInstallAttemptResult {
	retry: boolean;
	message?: string;
	cancelled?: boolean;
}

const MAX_START_ATTEMPTS = 3;
const MAX_REFERENCES = 50;
const MAX_SYMBOL_LINES = 200;
const MAX_CROSS_FILE_REPORTS = 5;
const LSP_INSTALL_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_INSTALL_OUTPUT_CHARS = 12000;

function uriToPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

function isPathAtOrInside(parentPath: string, candidatePath: string): boolean {
	const relativePath = relative(parentPath, candidatePath);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function installRecipeIdentity(recipe: LspInstallRecipe): string {
	return `${recipe.binary}\u0000${recipe.command.join("\u0000")}`;
}

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
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

interface CallHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: LspRange;
	selectionRange?: LspRange;
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

function appendBoundedOutput(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= MAX_INSTALL_OUTPUT_CHARS) {
		return next;
	}
	return next.slice(next.length - MAX_INSTALL_OUTPUT_CHARS);
}

function commandToDisplay(command: readonly string[]): string {
	return command.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function terminateProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		if (process.platform === "win32") {
			spawnProcessSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				encoding: "utf-8",
				stdio: "ignore",
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// Process already exited.
	}
}

export function runDefaultLspInstallCommand(
	command: readonly string[],
	options: LspInstallCommandOptions,
): Promise<LspInstallCommandResult> {
	if (command.length === 0) {
		return Promise.reject(new Error("LSP install command cannot be empty"));
	}
	if (options.signal?.aborted) {
		return Promise.reject(new Error("LSP server install aborted"));
	}

	return new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		const child = spawnProcess(command[0], [...command.slice(1)], {
			cwd: options.cwd,
			env: getSubprocessEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		const cleanup = (): void => {
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: LspInstallCommandResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(result);
		};
		const fail = (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(error);
		};
		function onAbort(): void {
			terminateProcessTree(child);
			fail(new Error("LSP server install aborted"));
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			output = appendBoundedOutput(output, text);
			options.onChunk?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			output = appendBoundedOutput(output, text);
			options.onChunk?.(text);
		});
		child.once("error", (error) => {
			fail(new Error(`Failed to run LSP install command "${commandToDisplay(command)}": ${error.message}`));
		});
		child.once("close", (code) => {
			finish({ exitCode: code, output });
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
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

type DocumentSession = { error: string } | { client: LspClient; uri: string; content: string; absolutePath: string };

class MissingLspExecutableError extends Error {
	readonly key: string;
	readonly launch: LspLaunchDescriptor;

	constructor(serverName: string, key: string, launch: LspLaunchDescriptor, projectCwd: string) {
		const sourceContext =
			launch.source === "path"
				? `in the inherited PATH (relative entries based at ${projectCwd})`
				: launch.source === "project-relative"
					? `relative to project workspace ${projectCwd}`
					: "at the configured absolute path";
		super(
			`Failed to start LSP server "${serverName}": ${launch.requestedExecutable} was not found ${sourceContext} (ENOENT)`,
		);
		this.key = key;
		this.launch = launch;
	}
}

class UnusableLspExecutableError extends Error {
	readonly key: string;
	readonly launch: LspLaunchDescriptor;

	constructor(serverName: string, key: string, launch: LspLaunchDescriptor) {
		super(
			`Failed to start LSP server "${serverName}": ${launch.requestedExecutable} is present but not executable: ${launch.unusableExecutable ?? launch.requestedExecutable} (EACCES)`,
		);
		this.key = key;
		this.launch = launch;
	}
}

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
	private displayCwd: string;
	private projectCwd: string;
	private lexicalWorkspaceRoots: string[];
	private config: ResolvedLspConfig;
	private clients = new Map<string, LspClient>();
	private launches = new Map<string, LspLaunchDescriptor>();
	private startAttempts = new Map<string, number>();
	private startFailures = new Map<string, ServerFailureState>();
	private hostInteraction: HostInteraction | undefined;
	private installRunner: LspInstallRunner;
	private installPromptsUsed = new Set<string>();
	private installAttempts = new Map<string, Promise<LspInstallAttemptResult>>();
	private installAbortController = new AbortController();
	private disposed = false;
	private commandQueues = new Map<LspClient, Promise<void>>();
	private commandApplyContexts = new Map<
		LspClient,
		{ snapshots: WorkspaceEditDocumentSnapshot[]; summaries: string[] }
	>();
	private lastUsedAt = new Map<string, number>();
	private idleTimer: NodeJS.Timeout | undefined;
	private tracer: LspTracer | undefined;

	constructor(options: LspManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		const lexicalProjectCwd = resolvePath(options.projectCwd ?? this.cwd);
		this.projectCwd = canonicalizePath(lexicalProjectCwd);
		const canonicalRuntimeCwd = canonicalizePath(this.cwd);
		this.displayCwd = canonicalRuntimeCwd;
		this.lexicalWorkspaceRoots = [
			...new Set([
				lexicalProjectCwd,
				this.projectCwd,
				...(isPathAtOrInside(this.projectCwd, canonicalRuntimeCwd) ? [this.cwd] : []),
			]),
		];
		this.config = options.config;
		this.hostInteraction = options.hostInteraction;
		this.installRunner = options.installRunner ?? runDefaultLspInstallCommand;
		if (this.config.traceFile) {
			this.tracer = new LspTracer(resolvePath(this.config.traceFile, this.projectCwd));
		}
		if (this.config.idleShutdownMs > 0) {
			const checkIntervalMs = Math.max(250, Math.min(this.config.idleShutdownMs / 2, 60000));
			this.idleTimer = setInterval(() => this.shutdownIdleClients(), checkIntervalMs);
			this.idleTimer.unref();
		}
	}

	setHostInteraction(hostInteraction: HostInteraction | undefined): void {
		this.hostInteraction = hostInteraction;
	}

	private async canonicalizeRequestedPath(inputPath: string): Promise<{ path: string } | { error: string }> {
		const lexicalPath = resolvePath(inputPath, this.cwd);
		const lexicallyInside =
			this.lexicalWorkspaceRoots.some((root) => isPathAtOrInside(root, lexicalPath)) ||
			this.lexicalWorkspaceRoots.some((root) => isPathAtOrInside(root.toLowerCase(), lexicalPath.toLowerCase()));

		let probe = lexicalPath;
		const missingSuffix: string[] = [];
		let canonicalPath: string;
		while (true) {
			try {
				canonicalPath = resolve(await realpath(probe), ...missingSuffix);
				break;
			} catch (error) {
				if (!isMissingPathError(error)) {
					return {
						error: `Could not resolve LSP path ${lexicalPath}: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				try {
					if ((await lstat(probe)).isSymbolicLink()) {
						return {
							error: lexicallyInside
								? `Refusing LSP access through a dangling symlink in project workspace ${this.projectCwd}: ${lexicalPath}`
								: `Refusing LSP access outside project workspace ${this.projectCwd}: ${lexicalPath}`,
						};
					}
				} catch (lstatError) {
					if (!isMissingPathError(lstatError)) {
						return {
							error: `Could not resolve LSP path ${lexicalPath}: ${lstatError instanceof Error ? lstatError.message : String(lstatError)}`,
						};
					}
				}
				const parent = dirname(probe);
				if (parent === probe) {
					return { error: `Could not resolve LSP path ${lexicalPath}` };
				}
				missingSuffix.unshift(probe.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
				probe = parent;
			}
		}
		if (!lexicallyInside) {
			return {
				error: `Refusing LSP access outside project workspace ${this.projectCwd}: ${lexicalPath}`,
			};
		}
		if (!isPathAtOrInside(this.projectCwd, canonicalPath)) {
			return {
				error: `Refusing LSP access through a symlink outside project workspace ${this.projectCwd}: ${lexicalPath} -> ${canonicalPath}`,
			};
		}
		return { path: canonicalPath };
	}

	getWorkspaceRoot(): string {
		return this.projectCwd;
	}

	/** Status of all spawned language servers. */
	getStatus(): LspServerStatus[] {
		const now = Date.now();
		const keys = new Set([...this.clients.keys(), ...this.startFailures.keys()]);
		return [...keys].map((key) => {
			const [name, root] = key.split("\u0000");
			const client = this.clients.get(key);
			const launch = this.launches.get(key);
			const failure = this.startFailures.get(key);
			return {
				name,
				workspaceRoot: this.projectCwd,
				root,
				alive: client?.isAlive ?? false,
				openDocuments: client?.openDocumentCount ?? 0,
				idleMs: now - (this.lastUsedAt.get(key) ?? now),
				...(launch?.resolvedExecutable
					? { resolvedExecutable: launch.resolvedExecutable }
					: { unresolvedCommand: launch?.unusableExecutable ?? launch?.requestedExecutable ?? "unknown" }),
				launchSource: launch?.source ?? "path",
				attempts: this.startAttempts.get(key) ?? 0,
				...(failure ? { lastError: failure.lastError } : {}),
			};
		});
	}

	/** Path of the active trace file, if tracing is enabled. */
	getTraceFile(): string | undefined {
		return this.tracer?.filePath;
	}

	/** Enable or disable protocol tracing for current and future servers. */
	async setTraceFile(filePath: string | undefined): Promise<void> {
		const previousTracer = this.tracer;
		this.tracer = filePath ? new LspTracer(resolvePath(filePath, this.projectCwd)) : undefined;
		for (const client of this.clients.values()) {
			client.setTracer(this.tracer);
		}
		await previousTracer?.dispose();
	}

	/** Synchronously stop tracing during non-awaitable process teardown. */
	closeTraceSync(): void {
		const previousTracer = this.tracer;
		this.tracer = undefined;
		for (const client of this.clients.values()) {
			client.setTracer(undefined);
		}
		previousTracer?.disposeSync();
	}

	/** Dispose all running servers. They respawn lazily on next use. Returns the number stopped. */
	restart(): number {
		const count = this.clients.size;
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.commandQueues.clear();
		this.commandApplyContexts.clear();
		this.lastUsedAt.clear();
		this.launches.clear();
		this.startAttempts.clear();
		this.startFailures.clear();
		this.installPromptsUsed.clear();
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
				if (!this.startFailures.has(key)) {
					this.launches.delete(key);
					this.startAttempts.delete(key);
				}
			}
		}
	}

	/**
	 * Collect diagnostics for a file that was just written.
	 *
	 * Also reports other open files that went from clean to failing as a result
	 * of this change (best-effort: depends on the server republishing for open
	 * documents within the settle window).
	 *
	 * Returns formatted diagnostics text, or undefined when no matching server
	 * is configured, the server is unavailable, or there is nothing to report.
	 */
	async getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<string | undefined> {
		if (this.disposed) {
			return undefined;
		}
		const canonical = await this.canonicalizeRequestedPath(absolutePath);
		if ("error" in canonical) {
			return `lsp(workspace): ${canonical.error}`;
		}
		absolutePath = canonical.path;
		const server = this.findServer(absolutePath);
		if (!server) {
			return undefined;
		}
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = this.serverKey(server.name, root);

		while (!this.disposed) {
			const failure = this.startFailures.get(key);
			if (failure && failure.count >= MAX_START_ATTEMPTS) {
				return undefined;
			}

			let client: LspClient;
			try {
				client = this.getClient(server, root);
			} catch (error) {
				if (error instanceof UnusableLspExecutableError) {
					return this.handleUnusableExecutable(server, error).message;
				}
				if (!(error instanceof MissingLspExecutableError)) throw error;
				const result = await this.handleMissingExecutable(server, error, signal);
				if (result.retry) continue;
				return result.message;
			}
			const cleanBefore = this.collectCleanOpenDocuments(client, absolutePath);
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
				const result = await this.handleClientError(server, key, client, error);
				if (result.retry) {
					continue;
				}
				return result.message;
			}
			if (this.disposed) {
				return undefined;
			}
			this.startFailures.delete(key);

			const ownDiagnostics = this.formatDiagnostics(absolutePath, diagnostics);
			const crossFile = this.formatNewlyFailing(client, absolutePath, cleanBefore);
			if (ownDiagnostics && crossFile) {
				return `${ownDiagnostics}\n${crossFile}`;
			}
			return ownDiagnostics ?? crossFile;
		}

		return undefined;
	}

	/** Paths of other open documents that currently have no reportable diagnostics. */
	private collectCleanOpenDocuments(client: LspClient, excludePath: string): Set<string> {
		const clean = new Set<string>();
		for (const path of client.getOpenDocumentPaths()) {
			if (path === excludePath) {
				continue;
			}
			const reportable = client
				.getPublishedDiagnostics(path)
				.filter((diagnostic) => (diagnostic.severity ?? 1) <= this.config.maxSeverity);
			if (reportable.length === 0) {
				clean.add(path);
			}
		}
		return clean;
	}

	/** Report open documents that went from clean to failing since the snapshot. */
	private formatNewlyFailing(client: LspClient, excludePath: string, cleanBefore: Set<string>): string | undefined {
		const sections: string[] = [];
		for (const path of client.getOpenDocumentPaths()) {
			if (path === excludePath || !cleanBefore.has(path)) {
				continue;
			}
			const formatted = this.formatDiagnostics(path, client.getPublishedDiagnostics(path));
			if (formatted) {
				sections.push(formatted);
			}
		}
		if (sections.length === 0) {
			return undefined;
		}
		const shown = sections.slice(0, MAX_CROSS_FILE_REPORTS);
		if (sections.length > shown.length) {
			shown.push(
				`... and ${sections.length - shown.length} more file${sections.length - shown.length === 1 ? "" : "s"}`,
			);
		}
		return `Newly failing in other open files:\n${shown.join("\n")}`;
	}

	dispose(): void {
		this.disposed = true;
		this.installAbortController.abort();
		this.installAttempts.clear();
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = undefined;
		}
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.commandQueues.clear();
		this.commandApplyContexts.clear();
		this.lastUsedAt.clear();
		this.launches.clear();
		this.startAttempts.clear();
		this.startFailures.clear();
		void this.tracer?.dispose();
		this.tracer = undefined;
	}

	// =========================================================================
	// Navigation (LspNavigationProvider)
	// =========================================================================

	async definition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/definition", "definition", absolutePath, symbol, line, signal);
	}

	async references(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/references", "references", absolutePath, symbol, line, signal);
	}

	async implementations(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/implementation", "implementations", absolutePath, symbol, line, signal);
	}

	async typeDefinition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string> {
		return this.locationQuery("textDocument/typeDefinition", "type definition", absolutePath, symbol, line, signal);
	}

	async hover(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const result = (await session.client.sendRequest(
				"textDocument/hover",
				{ textDocument: { uri: session.uri }, position },
				signal,
			)) as LspHoverResult | null;
			const text = result ? hoverContentsToText(result.contents).trim() : "";
			return text.length > 0 ? text : `No hover information for "${symbol}".`;
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async documentSymbols(absolutePath: string, signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest(
				"textDocument/documentSymbol",
				{ textDocument: { uri: session.uri } },
				signal,
			)) as LspDocumentSymbol[] | null;
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

	async callHierarchy(
		absolutePath: string,
		symbol: string,
		direction: "incoming" | "outgoing",
		line?: number,
		signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const items = (await session.client.sendRequest(
				"textDocument/prepareCallHierarchy",
				{ textDocument: { uri: session.uri }, position },
				signal,
			)) as CallHierarchyItem[] | null;
			if (!items || items.length === 0) {
				return `No call hierarchy available for "${symbol}" (it may not be a callable symbol).`;
			}
			const item = items[0];
			const label = direction === "incoming" ? "callers of" : "calls made by";
			const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
			const calls = (await session.client.sendRequest(method, { item }, signal)) as Array<{
				from?: CallHierarchyItem;
				to?: CallHierarchyItem;
			}> | null;
			if (!calls || calls.length === 0) {
				return `No ${label} "${item.name}" found.`;
			}
			const shown = calls.slice(0, MAX_REFERENCES);
			const lines: string[] = [`${direction === "incoming" ? "Callers of" : "Calls made by"} "${item.name}":`];
			for (const call of shown) {
				const target = direction === "incoming" ? call.from : call.to;
				if (!target) {
					continue;
				}
				const kind = SYMBOL_KIND_NAMES[target.kind] ?? "symbol";
				const canonical = await this.canonicalizeRequestedPath(uriToPath(target.uri));
				const path = "error" in canonical ? "[outside project workspace]" : this.displayPath(canonical.path);
				const targetLine = (target.selectionRange ?? target.range).start.line + 1;
				lines.push(`${target.name} (${kind}) ${path}:${targetLine}`);
			}
			if (calls.length > shown.length) {
				lines.push(`... and ${calls.length - shown.length} more`);
			}
			return lines.join("\n");
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async workspaceSymbols(absolutePath: string, query: string, signal?: AbortSignal): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest("workspace/symbol", { query }, signal)) as Array<{
				name: string;
				kind: number;
				containerName?: string;
				location?: { uri: string; range?: LspRange };
			}> | null;
			if (!result || result.length === 0) {
				return `No workspace symbols matching "${query}".`;
			}
			const shown = result.slice(0, MAX_REFERENCES);
			const lines = await Promise.all(
				shown.map(async (symbol) => {
					const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
					const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
					let location = "";
					if (symbol.location?.uri) {
						const canonical = await this.canonicalizeRequestedPath(uriToPath(symbol.location.uri));
						const path = "error" in canonical ? "[outside project workspace]" : this.displayPath(canonical.path);
						const line = symbol.location.range ? `:${symbol.location.range.start.line + 1}` : "";
						location = ` ${path}${line}`;
					}
					return `${symbol.name} (${kind})${container}${location}`;
				}),
			);
			if (result.length > shown.length) {
				lines.push(`... and ${result.length - shown.length} more`);
			}
			return lines.join("\n");
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async fileDiagnostics(absolutePath: string, signal?: AbortSignal): Promise<string> {
		// openSession applies the start-failure breaker and failure accounting,
		// so a broken server is not respawned on every diagnostics request.
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const diagnostics = await session.client.getDiagnostics(
				session.absolutePath,
				session.content,
				this.config.settleMs,
				this.config.firstSettleMs,
				signal,
			);
			return (
				this.formatDiagnostics(session.absolutePath, diagnostics) ??
				`No diagnostics in ${this.displayPath(session.absolutePath)}.`
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
		signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const result = await session.client.sendRequest(
				method,
				{
					textDocument: { uri: session.uri },
					position,
					...(method === "textDocument/references" ? { context: { includeDeclaration: true } } : {}),
				},
				signal,
			);
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
	private async openSession(absolutePath: string, signal?: AbortSignal): Promise<DocumentSession> {
		const canonical = await this.canonicalizeRequestedPath(absolutePath);
		if ("error" in canonical) {
			return { error: `lsp(workspace): ${canonical.error}` };
		}
		absolutePath = canonical.path;
		const server = this.findServer(absolutePath);
		if (!server) {
			return { error: this.noServerMessage(absolutePath) };
		}
		let content: string;
		try {
			content = await readFile(absolutePath, "utf-8");
		} catch (error) {
			return {
				error: `Could not read ${this.displayPath(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = this.serverKey(server.name, root);

		while (!this.disposed) {
			const failure = this.startFailures.get(key);
			if (failure && failure.count >= MAX_START_ATTEMPTS) {
				return {
					error: `lsp(${server.name}): server unavailable after ${failure.count} failed starts. Last error: ${failure.lastError}`,
				};
			}
			let client: LspClient;
			try {
				client = this.getClient(server, root);
			} catch (error) {
				if (error instanceof UnusableLspExecutableError) {
					const result = this.handleUnusableExecutable(server, error);
					return { error: result.message ?? `lsp(${server.name}): ${error.message}` };
				}
				if (!(error instanceof MissingLspExecutableError)) throw error;
				const result = await this.handleMissingExecutable(server, error, signal);
				if (result.retry) continue;
				return { error: result.message ?? `lsp(${server.name}): ${error.message}` };
			}
			try {
				const uri = await client.openDocument(absolutePath, content);
				await this.refreshStale(client, absolutePath);
				this.startFailures.delete(key);
				return { client, uri, content, absolutePath };
			} catch (error) {
				const result = await this.handleClientError(server, key, client, error);
				if (result.retry) {
					continue;
				}
				return {
					error:
						result.message ?? `lsp(${server.name}): ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		return { error: `lsp(${server.name}): LSP manager disposed.` };
	}

	async rename(
		absolutePath: string,
		symbol: string,
		newName: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`;
		}
		try {
			const snapshots = session.client.captureWorkspaceEditSnapshots();
			const result = (await session.client.sendRequest(
				"textDocument/rename",
				{ textDocument: { uri: session.uri }, position, newName },
				signal,
			)) as LspWorkspaceEdit | null;
			if (!result || normalizeWorkspaceEdit(result).length === 0) {
				return `Rename of "${symbol}" is not available at this position.`;
			}
			const applied = await this.applyWorkspaceEdit(session.client, result, snapshots);
			this.assertWorkspaceEditApplied(applied);
			return `Renamed "${symbol}" to "${newName}":\n${applied.summary}`;
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async codeFix(
		absolutePath: string,
		options: { symbol?: string; line?: number; title?: string; kind?: string },
		signal?: AbortSignal,
	): Promise<string> {
		const session = await this.openSession(absolutePath, signal);
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
		let published = session.client.getPublishedDiagnostics(session.absolutePath);
		if (published.length === 0) {
			try {
				published = await session.client.getDiagnostics(
					session.absolutePath,
					session.content,
					this.config.settleMs,
					this.config.firstSettleMs,
					signal,
				);
			} catch {
				// Code actions may still be available without diagnostics context.
			}
		}
		const diagnostics = published.filter((diagnostic) => rangesOverlap(diagnostic.range, range));
		try {
			const snapshots = session.client.captureWorkspaceEditSnapshots();
			const result = await session.client.sendRequest(
				"textDocument/codeAction",
				{
					textDocument: { uri: session.uri },
					range,
					context: { diagnostics, ...(options.kind ? { only: [options.kind] } : {}) },
				},
				signal,
			);
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
			return await this.applyCodeAction(session.client, chosen, snapshots, signal);
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	private async applyCodeAction(
		client: LspClient,
		action: NormalizedCodeAction,
		snapshots: WorkspaceEditDocumentSnapshot[],
		signal?: AbortSignal,
	): Promise<string> {
		let edit = action.edit;
		if (!edit) {
			// Servers may defer the edit to codeAction/resolve.
			try {
				snapshots = client.captureWorkspaceEditSnapshots();
				const resolved = (await client.sendRequest("codeAction/resolve", action.raw, signal)) as {
					edit?: LspWorkspaceEdit;
				} | null;
				edit = resolved?.edit;
			} catch {
				// Fall back to the command below.
			}
		}
		if (edit && normalizeWorkspaceEdit(edit).length > 0) {
			const applied = await this.applyWorkspaceEdit(client, edit, snapshots);
			this.assertWorkspaceEditApplied(applied);
			return `Applied "${action.title}":\n${applied.summary}`;
		}
		if (action.command) {
			return this.withClientCommandQueue(client, async () => {
				const context = { snapshots: client.captureWorkspaceEditSnapshots(), summaries: [] as string[] };
				this.commandApplyContexts.set(client, context);
				try {
					await client.sendRequest(
						"workspace/executeCommand",
						{ command: action.command?.command, arguments: action.command?.arguments ?? [] },
						signal,
					);
				} finally {
					this.commandApplyContexts.delete(client);
				}
				if (context.summaries.length > 0) {
					return `Applied "${action.title}":\n${context.summaries.join("\n")}`;
				}
				return `Executed "${action.title}" (no workspace edits reported).`;
			});
		}
		return `Code action "${action.title}" produced no edits.`;
	}

	private async withClientCommandQueue<T>(client: LspClient, fn: () => Promise<T>): Promise<T> {
		const previous = this.commandQueues.get(client) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveQueue) => {
			release = resolveQueue;
		});
		const queued = previous.then(() => current);
		this.commandQueues.set(client, queued);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.commandQueues.get(client) === queued) {
				this.commandQueues.delete(client);
			}
		}
	}

	private async applyWorkspaceEdit(
		client: LspClient,
		edit: LspWorkspaceEdit,
		snapshots: readonly WorkspaceEditDocumentSnapshot[],
	): Promise<WorkspaceEditApplyResult> {
		const result = await applyWorkspaceEditToDisk({
			rootDir: this.projectCwd,
			edit,
			snapshots,
			canonicalizePath: async (absolutePath) => {
				const canonical = await this.canonicalizeRequestedPath(absolutePath);
				if ("error" in canonical) throw new Error(canonical.error);
				return canonical.path;
			},
		});
		await client.applyWorkspaceChanges(result.changes);
		return result;
	}

	private assertWorkspaceEditApplied(result: WorkspaceEditApplyResult): void {
		if (result.applied) {
			return;
		}
		const index = result.failedChange === undefined ? "" : ` at operation ${result.failedChange}`;
		throw new Error(`LSP workspace edit failed${index}: ${result.failureReason ?? "unknown failure"}`);
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
		const canonical = await this.canonicalizeRequestedPath(uriToPath(location.uri));
		if ("error" in canonical) {
			return `[outside project workspace]:${location.range.start.line + 1}:${location.range.start.character + 1}`;
		}
		const path = canonical.path;
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
		const rel = relative(this.displayCwd, absolutePath);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
	}

	private findServer(absolutePath: string): ResolvedLspServerConfig | undefined {
		const ext = extname(absolutePath).toLowerCase();
		if (!ext) {
			return undefined;
		}
		return this.config.servers.find((server) => server.fileExtensions.includes(ext));
	}

	private serverKey(serverName: string, root: string): string {
		return `${serverName}\u0000${root}`;
	}

	private findRoot(absolutePath: string, rootMarkers: string[]): string {
		// Markers are priority-ordered, but no lookup may cross projectCwd.
		for (const marker of rootMarkers) {
			// Root markers are entry names, not paths. This keeps marker probing
			// from following configured parent components outside the workspace.
			if (marker !== basename(marker) || marker === "." || marker === "..") continue;
			let dir = dirname(absolutePath);
			while (isPathAtOrInside(this.projectCwd, dir)) {
				const markerPath = resolve(dir, marker);
				if (isPathAtOrInside(this.projectCwd, markerPath) && pathEntryExists(markerPath)) {
					return canonicalizePath(dir);
				}
				if (dir === this.projectCwd) break;
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
		return this.projectCwd;
	}

	private getClient(server: ResolvedLspServerConfig, root: string): LspClient {
		const key = this.serverKey(server.name, root);
		this.lastUsedAt.set(key, Date.now());
		const existing = this.clients.get(key);
		if (existing?.isAlive) {
			return existing;
		}
		existing?.dispose();
		this.clients.delete(key);

		const launch = resolveLspLaunch(server.command, { projectCwd: this.projectCwd });
		this.launches.set(key, launch);
		const attempt = (this.startAttempts.get(key) ?? 0) + 1;
		this.startAttempts.set(key, attempt);
		if (!launch.resolvedExecutable) {
			if (launch.unusableExecutable) {
				throw new UnusableLspExecutableError(server.name, key, launch);
			}
			throw new MissingLspExecutableError(server.name, key, launch, this.projectCwd);
		}

		let clientRef!: LspClient;
		const client = new LspClient({
			serverName: server.name,
			command: launch.command,
			rootDir: root,
			environment: launch.environment,
			launchContext: {
				configuredCommand: launch.configuredCommand,
				source: launch.source,
				workspaceRoot: this.projectCwd,
				attempt,
			},
			initializationOptions: server.initializationOptions,
			settings: server.settings,
			tracer: this.tracer,
			resolveTrackedDocumentPath: async (absolutePath) => {
				const canonical = await this.canonicalizeRequestedPath(absolutePath);
				return "error" in canonical ? undefined : canonical.path;
			},
			onApplyEdit: async (edit) => {
				const context = this.commandApplyContexts.get(clientRef);
				const snapshots = context?.snapshots ?? clientRef.captureWorkspaceEditSnapshots();
				const result = await this.applyWorkspaceEdit(clientRef, edit as LspWorkspaceEdit, snapshots);
				if (context && result.applied) {
					context.snapshots = clientRef.captureWorkspaceEditSnapshots();
				}
				if (context && result.summary) {
					context.summaries.push(result.summary);
				}
				return {
					applied: result.applied,
					failureReason: result.failureReason,
					failedChange: result.failedChange,
				};
			},
		});
		clientRef = client;
		this.clients.set(key, client);
		return client;
	}

	private handleUnusableExecutable(
		server: ResolvedLspServerConfig,
		error: UnusableLspExecutableError,
	): { retry: false; message?: string } {
		return { retry: false, message: this.recordStartFailure(server, error.key, error.message) };
	}

	private async handleClientError(
		server: ResolvedLspServerConfig,
		key: string,
		client: LspClient,
		error: unknown,
	): Promise<LspClientErrorResult> {
		const message = error instanceof Error ? error.message : String(error);
		if (client.isAlive && !client.startFailed) {
			// Request-level failure on a started, healthy server: report it without
			// counting toward the start-failure breaker.
			return { retry: false, message: `lsp(${server.name}): ${message}` };
		}

		this.removeFailedClient(key, client);
		return { retry: false, message: this.recordStartFailure(server, key, message) };
	}

	private async handleMissingExecutable(
		server: ResolvedLspServerConfig,
		error: MissingLspExecutableError,
		signal?: AbortSignal,
	): Promise<LspClientErrorResult> {
		const failure = this.startFailures.get(error.key);
		const recipe = server.installRecipe;
		const installEligible =
			error.launch.bare && recipe !== undefined && recipe.binary === error.launch.requestedExecutable;
		const installPending = recipe && this.installAttempts.has(installRecipeIdentity(recipe));
		if (!this.disposed && installEligible && (!failure?.reported || installPending)) {
			const installResult = await this.tryInstallMissingServer(server, recipe, signal);
			if (this.disposed) return { retry: false };
			if (installResult.retry) return { retry: true };
			if (installResult.cancelled) return { retry: false, message: installResult.message };
			return {
				retry: false,
				message: this.recordStartFailure(server, error.key, error.message, installResult.message),
			};
		}
		return { retry: false, message: this.recordStartFailure(server, error.key, error.message) };
	}

	private removeFailedClient(key: string, client: LspClient): void {
		// Remove and dispose the failed client (this also kills a process stuck
		// in the handshake) so the next call attempts a genuinely fresh start.
		if (this.clients.get(key) === client) this.clients.delete(key);
		client.dispose();
	}

	private recordStartFailure(
		server: ResolvedLspServerConfig,
		key: string,
		message: string,
		extraMessage?: string,
	): string | undefined {
		const launch = this.launches.get(key);
		const commandContext = launch?.resolvedExecutable
			? `Resolved executable: ${launch.resolvedExecutable}`
			: launch?.unusableExecutable
				? `Unusable executable: ${launch.unusableExecutable}`
				: `Unresolved command: ${launch?.requestedExecutable ?? server.command[0]}`;
		const sourceContext = launch ? `Launch source: ${launch.source}` : undefined;
		const repairContext = `Project workspace: ${this.projectCwd}; ${commandContext}${sourceContext ? `; ${sourceContext}` : ""}`;
		const hint = server.installHint;
		const explicitRepair =
			launch && !launch.bare
				? "Automatic install is unavailable for explicit paths; repair lsp.servers command configuration."
				: undefined;
		const actionable = [message, repairContext, hint, explicitRepair, extraMessage].filter(Boolean).join(". ");
		const failure = this.startFailures.get(key) ?? { count: 0, reported: false, lastError: actionable };
		failure.count++;
		failure.lastError = actionable;
		this.startFailures.set(key, failure);
		this.tracer?.log(server.name, "info", `startup failed: ${actionable}`);
		if (this.disposed || failure.reported) {
			return undefined;
		}
		failure.reported = true;
		return `lsp(${server.name}): ${actionable} (further failures for this server root will be silent until /lsp restart or /reload)`;
	}

	private async tryInstallMissingServer(
		server: ResolvedLspServerConfig,
		recipe: LspInstallRecipe,
		signal?: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		const interaction = this.hostInteraction;
		const identity = installRecipeIdentity(recipe);
		const existing = this.installAttempts.get(identity);
		if (existing) {
			return this.waitForInstallAttempt(existing, signal);
		}
		if (!interaction || this.installPromptsUsed.has(identity)) {
			return { retry: false };
		}

		const attempt = this.runInstallPrompt(
			server,
			recipe,
			identity,
			interaction,
			this.installAbortController.signal,
		).finally(() => {
			if (this.installAttempts.get(identity) === attempt) this.installAttempts.delete(identity);
		});
		this.installAttempts.set(identity, attempt);
		return this.waitForInstallAttempt(attempt, signal);
	}

	private waitForInstallAttempt(
		attempt: Promise<LspInstallAttemptResult>,
		signal?: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		const guardedAttempt = attempt.catch((error: unknown) => this.createInstallAttemptFailure(error));
		if (!signal) return guardedAttempt;
		const cancelled = { retry: false, message: "LSP install cancelled.", cancelled: true } as const;
		if (signal.aborted) return Promise.resolve(cancelled);

		return new Promise((resolveAttempt) => {
			let settled = false;
			const finish = (result: LspInstallAttemptResult): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolveAttempt(result);
			};
			function onAbort(): void {
				finish(cancelled);
			}
			signal.addEventListener("abort", onAbort, { once: true });
			void guardedAttempt.then(finish);
		});
	}

	private createInstallAttemptFailure(error: unknown): LspInstallAttemptResult {
		return {
			retry: false,
			message: `LSP install prompt failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	private async runInstallPrompt(
		server: ResolvedLspServerConfig,
		recipe: LspInstallRecipe,
		identity: string,
		interaction: HostInteraction,
		signal?: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		this.installPromptsUsed.add(identity);
		const requestId = `lsp-install-${randomUUID()}`;
		const decision = await interaction.requestAction(
			{
				id: requestId,
				action: "lsp.install_server",
				title: `Install ${server.name} language server?`,
				message: `Volt tried to use LSP for ${server.name}, but ${recipe.binary} is not installed. Install it now and retry diagnostics?`,
				confirmLabel: "Install",
				cancelLabel: "Skip",
				commandPreview: recipe.displayCommand,
				blocking: true,
				destructive: false,
				metadata: {
					server: server.name,
					binary: recipe.binary,
				},
				timeoutMs: LSP_INSTALL_REQUEST_TIMEOUT_MS,
			},
			{ signal },
		);

		if (decision.decision !== "approved") {
			return { retry: false, message: decision.message };
		}
		if (signal?.aborted) {
			return { retry: false, message: "LSP install cancelled." };
		}

		await this.emitHostActionUpdate({
			id: requestId,
			action: "lsp.install_server",
			status: "running",
			message: `Running ${recipe.displayCommand}`,
		});
		let result: LspInstallCommandResult;
		try {
			result = await this.installRunner(recipe.command, { cwd: this.projectCwd, signal });
		} catch (error) {
			const message = `LSP install failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.emitHostActionUpdate({
				id: requestId,
				action: "lsp.install_server",
				status: signal?.aborted ? "cancelled" : "failed",
				message,
			});
			return { retry: false, message };
		}

		if (result.exitCode !== 0) {
			const message = this.formatInstallFailure(recipe, result);
			await this.emitHostActionUpdate({
				id: requestId,
				action: "lsp.install_server",
				status: "failed",
				message,
				exitCode: result.exitCode,
			});
			return { retry: false, message };
		}

		await this.emitHostActionUpdate({
			id: requestId,
			action: "lsp.install_server",
			status: "completed",
			message: `${server.name} language server installed. Retrying diagnostics.`,
			exitCode: result.exitCode,
		});
		return { retry: true };
	}

	private formatInstallFailure(recipe: LspInstallRecipe, result: LspInstallCommandResult): string {
		const output = result.output.trim();
		const summary = `LSP install command failed (${recipe.displayCommand}) with exit code ${result.exitCode ?? "unknown"}.`;
		return output ? `${summary} Output:\n${output}` : summary;
	}

	private async emitHostActionUpdate(
		update: Parameters<NonNullable<HostInteraction["updateAction"]>>[0],
	): Promise<void> {
		try {
			await this.hostInteraction?.updateAction?.(update);
		} catch {
			// Host action updates are advisory; do not fail the underlying LSP operation.
		}
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
