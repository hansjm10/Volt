/**
 * Minimal LSP client speaking JSON-RPC over stdio.
 *
 * Implements only what the diagnostics feedback loop needs: the initialize
 * handshake, full-text document synchronization, push diagnostics
 * (textDocument/publishDiagnostics), and pull diagnostics
 * (textDocument/diagnostic) when the server advertises support.
 */

import type { ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { getSubprocessEnv } from "../../utils/process-env.ts";
import type { LspLaunchSource } from "./command-resolver.ts";
import { languageIdForExtension } from "./config.ts";
import type { LspTracer } from "./trace.ts";
import type { AppliedWorkspaceChange, WorkspaceEditDocumentSnapshot } from "./workspace-edit-applier.ts";

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: number | string;
	source?: string;
	message: string;
}

export interface LspClientOptions {
	serverName: string;
	command: string[];
	rootDir: string;
	/** Exact inherited environment used to resolve and launch the executable. */
	environment?: NodeJS.ProcessEnv;
	/** Launch context included in protocol traces. */
	launchContext?: {
		configuredCommand: string[];
		source: LspLaunchSource;
		workspaceRoot: string;
		attempt: number;
	};
	initializationOptions?: unknown;
	/**
	 * Server configuration. Sent via workspace/didChangeConfiguration after the
	 * handshake and used to answer workspace/configuration section requests.
	 */
	settings?: unknown;
	/** Timeout for individual LSP requests (including initialize). Default: 30000 */
	requestTimeoutMs?: number;
	/** Handler for server-initiated workspace/applyEdit requests. */
	onApplyEdit?: (edit: unknown) => Promise<boolean | LspApplyEditResult>;
	/** Protocol tracer. Can also be set later via setTracer(). */
	tracer?: LspTracer;
}

export interface LspApplyEditResult {
	applied: boolean;
	failureReason?: string;
	failedChange?: number;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface PublishedDiagnostics {
	diagnostics: LspDiagnostic[];
	seq: number;
	/** Document version from the publish notification, when the server provided one */
	version?: number;
}

interface PublishWaiter {
	uri: string;
	sinceSeq: number;
	resolve: () => void;
}

interface TrackedDocument {
	uri: string;
	absolutePath: string;
	version: number;
	/** The exact content last synced to the server */
	content: string;
	/** Disk stat at last sync, used as a cheap staleness filter */
	mtimeMs?: number;
	size?: number;
}

/** LSP FileChangeType values for workspace/didChangeWatchedFiles */
const FILE_CHANGE_TYPE_CREATED = 1;
const FILE_CHANGE_TYPE_CHANGED = 2;
const FILE_CHANGE_TYPE_DELETED = 3;

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_STARTUP_STDERR_CHARS = 8000;

/**
 * How long to re-wait for a fresher publish after an unversioned one when the
 * server has never tagged any publish with a version. Such servers publish
 * exactly once per change in the common case, so a full settle-window re-wait
 * would just run to the deadline on every edit; a racing stale publish and its
 * corrected follow-up arrive close together in practice.
 */
const UNVERSIONED_REPUBLISH_GRACE_MS = 250;

/**
 * A JSON-RPC error response: the server actively rejected the request (as
 * opposed to a timeout, abort, or server exit on our side).
 */
class LspResponseError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(`LSP error ${code}: ${message}`);
		this.code = code;
	}
}

function spawnServer(command: string[], cwd: string, environment: NodeJS.ProcessEnv): ChildProcess {
	return spawnProcess(command[0], command.slice(1), {
		cwd,
		env: environment,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
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
		// Process is already gone.
	}
}

/** Look up a dot-separated configuration section (e.g. "python.analysis") in a settings object. */
function lookupConfigSection(settings: unknown, section: unknown): unknown {
	if (typeof section !== "string" || section.length === 0) {
		return settings ?? null;
	}
	let current: unknown = settings;
	for (const part of section.split(".")) {
		if (current === null || typeof current !== "object") {
			return null;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current ?? null;
}

/** Normalize a file URI for map keys (Windows URIs vary in drive-letter casing and escaping). */
function normalizeUri(uri: string): string {
	let decoded = uri;
	try {
		decoded = decodeURIComponent(uri);
	} catch {
		// Keep the raw URI when decoding fails.
	}
	return process.platform === "win32" ? decoded.toLowerCase() : decoded;
}

function isPathAtOrInside(parentPath: string, candidatePath: string): boolean {
	const rel = relative(parentPath, candidatePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class LspClient {
	private options: LspClientOptions;
	private rootUri: string;
	private child: ChildProcess | undefined;
	private startPromise: Promise<void> | undefined;
	private startFailure = false;
	private alive = false;
	private disposed = false;
	private exitError: Error | undefined;
	private startupComplete = false;
	private startupStderr = "";

	private nextRequestId = 1;
	private pendingRequests = new Map<number, PendingRequest>();
	private readBuffer: Buffer = Buffer.alloc(0);

	private supportsPullDiagnostics = false;
	private documents = new Map<string, TrackedDocument>();
	private published = new Map<string, PublishedDiagnostics>();
	private publishSeq = 0;
	private publishWaiters: PublishWaiter[] = [];
	private everPublished = false;
	private everPublishedVersioned = false;
	private tracer: LspTracer | undefined;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.rootUri = pathToFileURL(options.rootDir).toString();
		this.tracer = options.tracer;
	}

	/** Enable or disable protocol tracing for this client. */
	setTracer(tracer: LspTracer | undefined): void {
		this.tracer = tracer;
	}

	get isAlive(): boolean {
		return this.alive && !this.disposed;
	}

	/** Whether the spawn/initialize handshake failed. Such a client never recovers. */
	get startFailed(): boolean {
		return this.startFailure;
	}

	/** Spawn the server process and run the initialize handshake. Memoized. */
	start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart().catch((error: unknown) => {
				this.startFailure = true;
				const original = error instanceof Error ? error : new Error(String(error));
				const stderr = this.startupStderr.trim();
				const enriched = stderr ? new Error(`${original.message}\nStartup stderr:\n${stderr}`) : original;
				this.exitError = enriched;
				throw enriched;
			});
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		const launch = this.options.launchContext;
		this.tracer?.log(
			this.options.serverName,
			"info",
			launch
				? `workspace: ${launch.workspaceRoot}; server root: ${this.options.rootDir}; configured argv: ${JSON.stringify(launch.configuredCommand)}; executable: ${this.options.command[0]}; source: ${launch.source}; attempt: ${launch.attempt}`
				: `server root: ${this.options.rootDir}; executable: ${this.options.command[0]}`,
		);
		this.tracer?.log(
			this.options.serverName,
			"info",
			`spawning: ${this.options.command.join(" ")} (root: ${this.options.rootDir})`,
		);
		const child = spawnServer(
			this.options.command,
			this.options.rootDir,
			this.options.environment ?? getSubprocessEnv(),
		);
		this.child = child;

		const spawnFailure = new Promise<never>((_, reject) => {
			child.once("error", (error) => {
				this.handleExit(new Error(`Failed to start LSP server "${this.options.serverName}": ${error.message}`));
				reject(this.exitError);
			});
			child.once("exit", (code) => {
				if (!this.disposed && !this.alive) {
					this.handleExit(
						new Error(
							`LSP server "${this.options.serverName}" exited during startup (code ${code ?? "unknown"})`,
						),
					);
					reject(this.exitError);
				}
			});
		});
		// Avoid unhandled rejection when startup succeeds and this promise loses the race.
		spawnFailure.catch(() => {});

		child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		// Drain stderr so the server cannot block on a full pipe.
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			if (!this.startupComplete) {
				const next = this.startupStderr + text;
				this.startupStderr =
					next.length <= MAX_STARTUP_STDERR_CHARS ? next : next.slice(next.length - MAX_STARTUP_STDERR_CHARS);
			}
			this.tracer?.log(this.options.serverName, "stderr", text);
		});
		child.stdin?.on("error", () => {});
		child.on("exit", (code) => {
			this.tracer?.log(this.options.serverName, "info", `process exited (code ${code ?? "unknown"})`);
			if (this.alive) {
				this.handleExit(new Error(`LSP server "${this.options.serverName}" exited (code ${code ?? "unknown"})`));
			}
		});

		this.alive = true;
		const initializeResult = (await Promise.race([
			this.request("initialize", {
				processId: process.pid,
				rootUri: this.rootUri,
				workspaceFolders: [{ uri: this.rootUri, name: basename(this.options.rootDir) }],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						publishDiagnostics: { versionSupport: true, relatedInformation: false },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
						definition: { dynamicRegistration: false, linkSupport: true },
						implementation: { dynamicRegistration: false, linkSupport: true },
						typeDefinition: { dynamicRegistration: false, linkSupport: true },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
						rename: { dynamicRegistration: false, prepareSupport: false },
						callHierarchy: { dynamicRegistration: false },
						codeAction: {
							dynamicRegistration: false,
							codeActionLiteralSupport: {
								codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
							},
							resolveSupport: { properties: ["edit"] },
						},
					},
					workspace: {
						configuration: true,
						workspaceFolders: true,
						didChangeWatchedFiles: { dynamicRegistration: false },
						didChangeConfiguration: { dynamicRegistration: false },
						symbol: { dynamicRegistration: false },
						applyEdit: true,
						workspaceEdit: {
							documentChanges: true,
							resourceOperations: ["create", "rename", "delete"],
							failureHandling: "abort",
						},
					},
					window: { workDoneProgress: false },
				},
				initializationOptions: this.options.initializationOptions,
			}),
			spawnFailure,
		])) as { capabilities?: { diagnosticProvider?: unknown } } | undefined;

		this.supportsPullDiagnostics = Boolean(initializeResult?.capabilities?.diagnosticProvider);
		this.notify("initialized", {});
		if (this.options.settings !== undefined) {
			this.notify("workspace/didChangeConfiguration", { settings: this.options.settings });
		}
		this.startupComplete = true;
	}

	/**
	 * Sync a document and collect its diagnostics.
	 *
	 * Refreshes other open documents from disk first, so dependency changes made
	 * outside the tools are reflected. Uses pull diagnostics when the server
	 * supports them; otherwise waits for the server to publish diagnostics for
	 * the document. The first collection on a fresh server waits up to
	 * firstSettleMs (servers like tsserver publish nothing until the project has
	 * loaded); afterwards settleMs applies.
	 */
	async getDiagnostics(
		absolutePath: string,
		content: string,
		settleMs: number,
		firstSettleMs?: number,
		signal?: AbortSignal,
	): Promise<LspDiagnostic[]> {
		await this.start();
		const sinceSeq = this.publishSeq;
		const refreshed = await this.refreshStaleDocuments(absolutePath);
		const { uri, changed } = await this.syncContent(absolutePath, content);
		const key = normalizeUri(uri);

		if (this.supportsPullDiagnostics) {
			// Pull results are request-ordered after the didChange above, so they
			// can never describe stale content. Retry once before falling back:
			// servers may reject a pull (e.g. ContentModified) while recomputing.
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const result = (await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal)) as
						| { kind?: string; items?: LspDiagnostic[] }
						| undefined;
					if (result?.kind === "full" && Array.isArray(result.items)) {
						this.everPublished = true;
						return result.items;
					}
					break;
				} catch (error) {
					// Retry once on an explicit server rejection (e.g. ContentModified
					// while recomputing): those come back fast, so a retry is cheap.
					// Timeouts, aborts, and server exits would only double the worst-case
					// latency, so fall back to published diagnostics immediately.
					if (!(error instanceof LspResponseError)) {
						break;
					}
				}
			}
		}

		// Reuse the last publish only when nothing changed at all: unchanged
		// content cannot republish, but refreshed dependencies can change this
		// document's diagnostics, so any refresh forces a fresh wait.
		const existing = this.published.get(key);
		if (!changed && refreshed.length === 0 && existing) {
			return existing.diagnostics;
		}

		const timeoutMs = this.everPublished ? settleMs : Math.max(settleMs, firstSettleMs ?? settleMs);
		const deadline = Date.now() + timeoutMs;
		await this.waitForPublish(key, sinceSeq, timeoutMs, signal);
		let entry = this.published.get(key);
		// An unversioned publish that arrives after our didChange can still have
		// been computed against the pre-change content (the version field is
		// optional in LSP, and cross-file invalidation from an earlier edit can
		// race the sync). When this document's content just changed — or its
		// dependencies were refreshed, which can equally change its diagnostics —
		// re-wait once for a fresher publish before trusting an unversioned one.
		// For servers that tag publishes with versions, an unversioned one is
		// anomalous and the versioned republish will resolve the wait promptly, so
		// use the full remaining deadline; for servers that never send versions,
		// cap the re-wait so every edit does not stall for the whole settle window.
		if (
			(changed || refreshed.length > 0) &&
			entry !== undefined &&
			entry.seq > sinceSeq &&
			entry.version === undefined
		) {
			const remainingMs = this.everPublishedVersioned
				? deadline - Date.now()
				: Math.min(deadline - Date.now(), UNVERSIONED_REPUBLISH_GRACE_MS);
			if (remainingMs > 0) {
				await this.waitForPublish(key, entry.seq, remainingMs, signal);
				entry = this.published.get(key) ?? entry;
			}
		}
		return entry?.diagnostics ?? [];
	}

	/** Sync a document to the server and return its URI. Starts the server if needed. */
	async openDocument(absolutePath: string, content: string): Promise<string> {
		await this.start();
		const { uri } = await this.syncContent(absolutePath, content);
		return uri;
	}

	/**
	 * Re-sync any open document whose on-disk content changed outside the edit
	 * and write tools (e.g. via bash). Deleted documents are closed. Servers are
	 * additionally notified via workspace/didChangeWatchedFiles so they can
	 * invalidate caches. Returns the absolute paths that were refreshed.
	 */
	async refreshStaleDocuments(excludePath?: string): Promise<string[]> {
		if (!this.isAlive) {
			return [];
		}
		const excludeKey = excludePath ? normalizeUri(pathToFileURL(excludePath).toString()) : undefined;
		const refreshed: Array<{ uri: string; type: number; absolutePath: string }> = [];
		for (const [key, document] of [...this.documents]) {
			if (key === excludeKey) {
				continue;
			}
			let fileStat: { mtimeMs: number; size: number };
			try {
				fileStat = await stat(document.absolutePath);
			} catch {
				// File was deleted (or became unreadable): close it on the server.
				this.documents.delete(key);
				this.published.delete(key);
				this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
				refreshed.push({ uri: document.uri, type: FILE_CHANGE_TYPE_DELETED, absolutePath: document.absolutePath });
				continue;
			}
			if (fileStat.mtimeMs === document.mtimeMs && fileStat.size === document.size) {
				continue;
			}
			let content: string;
			try {
				content = await readFile(document.absolutePath, "utf-8");
			} catch {
				continue;
			}
			document.mtimeMs = fileStat.mtimeMs;
			document.size = fileStat.size;
			if (content === document.content) {
				continue;
			}
			document.content = content;
			document.version++;
			this.notify("textDocument/didChange", {
				textDocument: { uri: document.uri, version: document.version },
				contentChanges: [{ text: content }],
			});
			refreshed.push({ uri: document.uri, type: FILE_CHANGE_TYPE_CHANGED, absolutePath: document.absolutePath });
		}
		if (refreshed.length > 0) {
			this.notify("workspace/didChangeWatchedFiles", {
				changes: refreshed.map(({ uri, type }) => ({ uri, type })),
			});
		}
		return refreshed.map(({ absolutePath }) => absolutePath);
	}

	/** Send an arbitrary LSP request. Starts the server if needed. */
	async sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		await this.start();
		return this.request(method, params, signal);
	}

	/** Whether the document is currently open (synced) on the server. */
	isDocumentOpen(absolutePath: string): boolean {
		return this.documents.has(normalizeUri(pathToFileURL(absolutePath).toString()));
	}

	/** Root directory this language server was initialized with. */
	get rootDir(): string {
		return this.options.rootDir;
	}

	/** Number of documents currently open on the server. */
	get openDocumentCount(): number {
		return this.documents.size;
	}

	/** Absolute paths of all documents currently open on the server. */
	getOpenDocumentPaths(): string[] {
		return [...this.documents.values()].map((document) => document.absolutePath);
	}

	/** Last published diagnostics for a document, if any. */
	getPublishedDiagnostics(absolutePath: string): LspDiagnostic[] {
		return this.published.get(normalizeUri(pathToFileURL(absolutePath).toString()))?.diagnostics ?? [];
	}

	/** @internal Capture the exact tracked-document state at the start of an LSP request. */
	captureWorkspaceEditSnapshots(): WorkspaceEditDocumentSnapshot[] {
		return [...this.documents.values()].map((document) => ({
			uri: document.uri,
			absolutePath: document.absolutePath,
			version: document.version,
			content: document.content,
		}));
	}

	/** @internal Reconcile successful on-disk WorkspaceEdit operations with server state. */
	async applyWorkspaceChanges(changes: readonly AppliedWorkspaceChange[]): Promise<void> {
		for (const change of changes) {
			if (change.kind === "edit" || change.kind === "create") {
				const uri = pathToFileURL(change.path).toString();
				const key = normalizeUri(uri);
				const document = this.documents.get(key);
				if (document) {
					document.content = change.content;
					document.version++;
					await this.updateTrackedStat(document);
					this.notify("textDocument/didChange", {
						textDocument: { uri: document.uri, version: document.version },
						contentChanges: [{ text: change.content }],
					});
				} else {
					this.notifyWatchedFile(
						uri,
						change.kind === "create" && !change.overwritten ? FILE_CHANGE_TYPE_CREATED : FILE_CHANGE_TYPE_CHANGED,
					);
				}
				continue;
			}

			if (change.kind === "rename") {
				const destinationDocuments = [...this.documents.entries()].filter(([, document]) =>
					isPathAtOrInside(change.newPath, document.absolutePath),
				);
				for (const [key, document] of destinationDocuments) {
					this.documents.delete(key);
					this.published.delete(key);
					this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
				}

				const sourceDocuments = [...this.documents.entries()].filter(([, document]) =>
					isPathAtOrInside(change.oldPath, document.absolutePath),
				);
				if (sourceDocuments.length === 0) {
					this.notifyWatchedFile(pathToFileURL(change.oldPath).toString(), FILE_CHANGE_TYPE_DELETED);
					this.notifyWatchedFile(pathToFileURL(change.newPath).toString(), FILE_CHANGE_TYPE_CREATED);
					continue;
				}
				for (const [key, document] of sourceDocuments) {
					this.documents.delete(key);
					this.published.delete(key);
					this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
					const suffix = relative(change.oldPath, document.absolutePath);
					const absolutePath = suffix ? join(change.newPath, suffix) : change.newPath;
					const uri = pathToFileURL(absolutePath).toString();
					const content = suffix || change.content === undefined ? document.content : change.content;
					const moved: TrackedDocument = { uri, absolutePath, version: 1, content };
					await this.updateTrackedStat(moved);
					this.documents.set(normalizeUri(uri), moved);
					this.notify("textDocument/didOpen", {
						textDocument: {
							uri,
							languageId: languageIdForExtension(extname(absolutePath)),
							version: 1,
							text: content,
						},
					});
				}
				continue;
			}

			const deletedDocuments = [...this.documents.entries()].filter(([, document]) =>
				isPathAtOrInside(change.path, document.absolutePath),
			);
			if (deletedDocuments.length === 0) {
				this.notifyWatchedFile(pathToFileURL(change.path).toString(), FILE_CHANGE_TYPE_DELETED);
				continue;
			}
			for (const [key, document] of deletedDocuments) {
				this.documents.delete(key);
				this.published.delete(key);
				this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
			}
		}
	}

	private async updateTrackedStat(document: TrackedDocument): Promise<void> {
		try {
			const metadata = await stat(document.absolutePath);
			document.mtimeMs = metadata.mtimeMs;
			document.size = metadata.size;
		} catch {
			document.mtimeMs = undefined;
			document.size = undefined;
		}
	}

	private notifyWatchedFile(uri: string, type: number): void {
		this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type }] });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const child = this.child;
		this.handleExit(new Error(`LSP client for "${this.options.serverName}" was disposed`));
		if (!child) {
			return;
		}
		try {
			this.sendMessage({ jsonrpc: "2.0", method: "exit" });
		} catch {
			// Best-effort graceful exit.
		}
		const killTimer = setTimeout(() => killProcessTree(child), 2000);
		killTimer.unref();
		child.once("exit", () => clearTimeout(killTimer));
		if (process.platform === "win32") {
			// cross-spawn may launch a command shim process, so terminate the whole
			// process tree instead of risking an orphaned language server.
			killProcessTree(child);
			clearTimeout(killTimer);
			return;
		}
		try {
			child.kill();
		} catch {
			// Process is already gone.
		}
	}

	// =========================================================================
	// Document sync and diagnostics collection
	// =========================================================================

	/**
	 * Sync explicit content for a document (didOpen on first sight, didChange
	 * after). Returns whether the synced view actually changed.
	 */
	private async syncContent(absolutePath: string, content: string): Promise<{ uri: string; changed: boolean }> {
		const uri = pathToFileURL(absolutePath).toString();
		const key = normalizeUri(uri);
		const existing = this.documents.get(key);

		let mtimeMs: number | undefined;
		let size: number | undefined;
		try {
			const fileStat = await stat(absolutePath);
			mtimeMs = fileStat.mtimeMs;
			size = fileStat.size;
		} catch {
			// Stat is only a staleness filter; missing files still sync in-memory content.
		}

		if (!existing) {
			this.documents.set(key, { uri, absolutePath, version: 1, content, mtimeMs, size });
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForExtension(extname(absolutePath)),
					version: 1,
					text: content,
				},
			});
			return { uri, changed: true };
		}

		existing.mtimeMs = mtimeMs;
		existing.size = size;
		if (existing.content === content) {
			return { uri, changed: false };
		}
		existing.content = content;
		existing.version++;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: existing.version },
			contentChanges: [{ text: content }],
		});
		return { uri, changed: true };
	}

	private waitForPublish(key: string, sinceSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const existing = this.published.get(key);
		if ((existing && existing.seq > sinceSeq) || !this.isAlive || signal?.aborted) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				const index = this.publishWaiters.indexOf(waiter);
				if (index !== -1) {
					this.publishWaiters.splice(index, 1);
				}
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			timer.unref();
			const waiter: PublishWaiter = { uri: key, sinceSeq, resolve: finish };
			this.publishWaiters.push(waiter);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	// =========================================================================
	// JSON-RPC transport
	// =========================================================================

	private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this.alive) {
			return Promise.reject(this.exitError ?? new Error(`LSP server "${this.options.serverName}" is not running`));
		}
		if (signal?.aborted) {
			return Promise.reject(new Error(`LSP request "${method}" was aborted`));
		}
		const id = this.nextRequestId++;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			// Wrap both settle paths so the timer and abort listener are always
			// cleaned up, no matter who settles the request (response, exit,
			// timeout, or abort).
			const settle = <T>(fn: (value: T) => void): ((value: T) => void) => {
				return (value: T): void => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					fn(value);
				};
			};
			const onAbort = (): void => {
				this.pendingRequests.delete(id);
				settle(reject)(new Error(`LSP request "${method}" was aborted`));
			};
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				settle(reject)(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pendingRequests.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
			this.sendMessage({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		if (!this.alive) {
			return;
		}
		this.sendMessage({ jsonrpc: "2.0", method, params });
	}

	private sendMessage(message: JsonRpcMessage): void {
		const body = JSON.stringify(message);
		this.tracer?.log(this.options.serverName, "send", body);
		const length = Buffer.byteLength(body, "utf-8");
		this.child?.stdin?.write(`Content-Length: ${length}\r\n\r\n${body}`);
	}

	private onData(chunk: Buffer): void {
		this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
		while (true) {
			const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = this.readBuffer.subarray(0, headerEnd).toString("ascii");
			const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
			if (!lengthMatch) {
				// Malformed header; drop it and resync on the next message boundary.
				this.readBuffer = this.readBuffer.subarray(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(lengthMatch[1], 10);
			const messageStart = headerEnd + 4;
			if (this.readBuffer.length < messageStart + contentLength) {
				return;
			}
			const body = this.readBuffer.subarray(messageStart, messageStart + contentLength).toString("utf-8");
			this.readBuffer = this.readBuffer.subarray(messageStart + contentLength);
			this.tracer?.log(this.options.serverName, "recv", body);
			try {
				this.onMessage(JSON.parse(body) as JsonRpcMessage);
			} catch {
				// Ignore unparseable messages.
			}
		}
	}

	private onMessage(message: JsonRpcMessage): void {
		if (message.id !== undefined && message.method !== undefined) {
			this.handleServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pendingRequests.get(Number(message.id));
			if (pending) {
				this.pendingRequests.delete(Number(message.id));
				clearTimeout(pending.timer);
				if (message.error) {
					pending.reject(new LspResponseError(message.error.code, message.error.message));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] } | undefined;
			if (params?.uri) {
				const key = normalizeUri(params.uri);
				this.everPublished = true;
				if (params.version !== undefined) {
					this.everPublishedVersioned = true;
				}
				// Ignore publishes computed against an older synced version: they
				// would satisfy the settle wait with stale diagnostics.
				const document = this.documents.get(key);
				if (params.version !== undefined && document !== undefined && params.version < document.version) {
					return;
				}
				const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
				// Unversioned publishes can be computed against stale content. Drop
				// those whose positions point past the end of the synced content:
				// they describe an older snapshot and would otherwise satisfy the
				// settle wait (and the cross-file sweep) with stale diagnostics.
				// Tolerate line === lineCount: the spec tells clients to clamp
				// out-of-range positions, and linters legitimately emit end-of-file
				// diagnostics one past the last line (e.g. missing trailing newline).
				if (params.version === undefined && document !== undefined && diagnostics.length > 0) {
					const lineCount = document.content.split("\n").length;
					if (diagnostics.some((diagnostic) => (diagnostic.range?.start?.line ?? 0) > lineCount)) {
						this.tracer?.log(
							this.options.serverName,
							"info",
							`dropping stale unversioned publish for ${params.uri} (position past end of synced content)`,
						);
						return;
					}
				}
				this.publishSeq++;
				this.published.set(key, {
					diagnostics,
					seq: this.publishSeq,
					version: params.version,
				});
				for (const waiter of [...this.publishWaiters]) {
					if (waiter.uri === key) {
						waiter.resolve();
					}
				}
			}
		}
	}

	private handleServerRequest(id: number | string, method: string, params: unknown): void {
		if (method === "workspace/applyEdit" && this.options.onApplyEdit) {
			const edit = (params as { edit?: unknown } | undefined)?.edit;
			void this.options
				.onApplyEdit(edit)
				.catch(
					(error: unknown): LspApplyEditResult => ({
						applied: false,
						failureReason: error instanceof Error ? error.message : String(error),
					}),
				)
				.then((result) => {
					try {
						this.sendMessage({
							jsonrpc: "2.0",
							id,
							result: typeof result === "boolean" ? { applied: result } : result,
						});
					} catch {
						// Server may have exited.
					}
				});
			return;
		}
		// Respond with sensible empty defaults so servers that depend on client
		// round-trips (configuration, capability registration) do not stall.
		let result: unknown = null;
		if (method === "workspace/configuration") {
			const items = (params as { items?: Array<{ section?: unknown }> } | undefined)?.items;
			result = Array.isArray(items)
				? items.map((item) => lookupConfigSection(this.options.settings, item?.section))
				: [];
		} else if (method === "workspace/workspaceFolders") {
			result = [{ uri: this.rootUri, name: basename(this.options.rootDir) }];
		}
		try {
			this.sendMessage({ jsonrpc: "2.0", id, result });
		} catch {
			// Server may have exited.
		}
	}

	private handleExit(error: Error): void {
		this.alive = false;
		this.exitError = this.exitError ?? error;
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(this.exitError);
		}
		this.pendingRequests.clear();
		for (const waiter of [...this.publishWaiters]) {
			waiter.resolve();
		}
		this.publishWaiters = [];
	}
}
