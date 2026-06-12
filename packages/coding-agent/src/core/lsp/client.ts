/**
 * Minimal LSP client speaking JSON-RPC over stdio.
 *
 * Implements only what the diagnostics feedback loop needs: the initialize
 * handshake, full-text document synchronization, push diagnostics
 * (textDocument/publishDiagnostics), and pull diagnostics
 * (textDocument/diagnostic) when the server advertises support.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { languageIdForExtension } from "./config.ts";

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
	initializationOptions?: unknown;
	/** Timeout for individual LSP requests (including initialize). Default: 30000 */
	requestTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface PublishedDiagnostics {
	diagnostics: LspDiagnostic[];
	seq: number;
}

interface PublishWaiter {
	uri: string;
	sinceSeq: number;
	resolve: () => void;
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function quoteWindowsArg(arg: string): string {
	return /\s/.test(arg) ? `"${arg}"` : arg;
}

function spawnServer(command: string[], cwd: string): ChildProcess {
	if (process.platform === "win32") {
		// Many language servers are installed as .cmd shims on Windows, which
		// cannot be spawned directly without a shell.
		const commandLine = command.map(quoteWindowsArg).join(" ");
		return spawn(commandLine, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	}
	return spawn(command[0], command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// Process is already gone.
	}
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

export class LspClient {
	private options: LspClientOptions;
	private rootUri: string;
	private child: ChildProcess | undefined;
	private startPromise: Promise<void> | undefined;
	private alive = false;
	private disposed = false;
	private exitError: Error | undefined;

	private nextRequestId = 1;
	private pendingRequests = new Map<number, PendingRequest>();
	private readBuffer: Buffer = Buffer.alloc(0);

	private supportsPullDiagnostics = false;
	private documentVersions = new Map<string, number>();
	private published = new Map<string, PublishedDiagnostics>();
	private publishSeq = 0;
	private publishWaiters: PublishWaiter[] = [];

	constructor(options: LspClientOptions) {
		this.options = options;
		this.rootUri = pathToFileURL(options.rootDir).toString();
	}

	get isAlive(): boolean {
		return this.alive && !this.disposed;
	}

	/** Spawn the server process and run the initialize handshake. Memoized. */
	start(): Promise<void> {
		if (!this.startPromise) {
			this.startPromise = this.doStart();
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		const child = spawnServer(this.options.command, this.options.rootDir);
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
		child.stderr?.on("data", () => {});
		child.stdin?.on("error", () => {});
		child.on("exit", (code) => {
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
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					},
					workspace: { configuration: true, workspaceFolders: true },
					window: { workDoneProgress: false },
				},
				initializationOptions: this.options.initializationOptions,
			}),
			spawnFailure,
		])) as { capabilities?: { diagnosticProvider?: unknown } } | undefined;

		this.supportsPullDiagnostics = Boolean(initializeResult?.capabilities?.diagnosticProvider);
		this.notify("initialized", {});
	}

	/**
	 * Sync a document and collect its diagnostics.
	 *
	 * Uses pull diagnostics when the server supports them; otherwise waits up to
	 * settleMs for the server to publish diagnostics for the document.
	 */
	async getDiagnostics(
		absolutePath: string,
		content: string,
		settleMs: number,
		signal?: AbortSignal,
	): Promise<LspDiagnostic[]> {
		await this.start();
		const uri = pathToFileURL(absolutePath).toString();
		const key = normalizeUri(uri);
		const sinceSeq = this.publishSeq;
		this.syncDocument(uri, absolutePath, content);

		if (this.supportsPullDiagnostics) {
			try {
				const result = (await this.request("textDocument/diagnostic", { textDocument: { uri } })) as
					| { kind?: string; items?: LspDiagnostic[] }
					| undefined;
				if (result?.kind === "full" && Array.isArray(result.items)) {
					return result.items;
				}
			} catch {
				// Fall back to published diagnostics below.
			}
		}

		await this.waitForPublish(key, sinceSeq, settleMs, signal);
		return this.published.get(key)?.diagnostics ?? [];
	}

	/** Sync a document to the server and return its URI. Starts the server if needed. */
	async openDocument(absolutePath: string, content: string): Promise<string> {
		await this.start();
		const uri = pathToFileURL(absolutePath).toString();
		this.syncDocument(uri, absolutePath, content);
		return uri;
	}

	/** Send an arbitrary LSP request. Starts the server if needed. */
	async sendRequest(method: string, params: unknown): Promise<unknown> {
		await this.start();
		return this.request(method, params);
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
			// On Windows the server runs under a shell, so child.kill() would only
			// terminate the shell and orphan the actual server process.
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

	private syncDocument(uri: string, absolutePath: string, content: string): void {
		const key = normalizeUri(uri);
		const version = this.documentVersions.get(key);
		if (version === undefined) {
			this.documentVersions.set(key, 1);
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForExtension(extname(absolutePath)),
					version: 1,
					text: content,
				},
			});
			return;
		}
		const nextVersion = version + 1;
		this.documentVersions.set(key, nextVersion);
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: nextVersion },
			contentChanges: [{ text: content }],
		});
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

	private request(method: string, params: unknown): Promise<unknown> {
		if (!this.alive) {
			return Promise.reject(this.exitError ?? new Error(`LSP server "${this.options.serverName}" is not running`));
		}
		const id = this.nextRequestId++;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			this.pendingRequests.set(id, { resolve, reject, timer });
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
					pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			if (params?.uri) {
				const key = normalizeUri(params.uri);
				this.publishSeq++;
				this.published.set(key, {
					diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
					seq: this.publishSeq,
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
		// Respond with sensible empty defaults so servers that depend on client
		// round-trips (configuration, capability registration) do not stall.
		let result: unknown = null;
		if (method === "workspace/configuration") {
			const items = (params as { items?: unknown[] } | undefined)?.items;
			result = Array.isArray(items) ? items.map(() => null) : [];
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
