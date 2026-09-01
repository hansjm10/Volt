import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isBundledCli, isStandaloneBinary } from "../../config.ts";
import { parseCanonicalSessionStoreJson, stringifyCanonicalSessionStoreJson } from "./canonical-json.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerOperation,
	parseSessionStoreWorkerResponseEnvelope,
	type SessionStoreWorkerOperation,
	type SessionStoreWorkerResponseEnvelope,
} from "./protocol.ts";
import {
	type SessionStoreApplyTransactionInput,
	type SessionStoreCommitReconciliation,
	type SessionStoreCreateSessionInput,
	type SessionStoreDeleteSessionInput,
	type SessionStoreDeleteSessionResult,
	SessionStoreError,
	type SessionStoreImportTransactionInput,
	type SessionStoreImportTransactionResult,
	type SessionStoreInfo,
	type SessionStoreListOptions,
	type SessionStoreReconcileCommitInput,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreTransactionResult,
} from "./types.ts";

interface PendingRequest {
	readonly kind: SessionStoreWorkerOperation["kind"];
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface SharedStoreEntry {
	readonly promise: Promise<SQLiteSessionStoreClient>;
	client?: SQLiteSessionStoreClient;
}

const sharedStores = new Map<string, SharedStoreEntry>();
const SQLITE_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

function workerModuleUrl(): URL {
	const moduleUrl: string | undefined = import.meta.url;
	if (isStandaloneBinary) return new URL("./session-store-worker.cjs", pathToFileURL(process.execPath));
	if (isBundledCli) return new URL("./session-store-worker.js", moduleUrl);
	return new URL(moduleUrl?.endsWith(".ts") ? "./worker.ts" : "./worker.js", moduleUrl);
}

function workerExecArgv(): string[] {
	return [...process.execArgv.filter((argument) => argument !== SQLITE_WARNING_FLAG), SQLITE_WARNING_FLAG];
}

export class SQLiteSessionStoreClient {
	readonly sessionDirectory: string;
	private readonly worker: Worker;
	private readonly pending = new Map<number, PendingRequest>();
	private storeInfo: SessionStoreInfo | undefined;
	private nextRequestId = 1;
	private closed = false;
	private closing = false;
	private expectedExit = false;
	private closePromise: Promise<void> | undefined;

	private constructor(sessionDirectory: string, worker: Worker) {
		this.sessionDirectory = sessionDirectory;
		this.worker = worker;
		this.attachWorkerListeners();
		this.worker.unref();
	}

	get info(): SessionStoreInfo {
		if (!this.storeInfo)
			throw new SessionStoreError("store_initialization_failed", "Session store is not initialized");
		return this.storeInfo;
	}

	static async open(sessionDirectory: string): Promise<SQLiteSessionStoreClient> {
		const resolvedDirectory = resolve(sessionDirectory);
		const worker = new Worker(workerModuleUrl(), {
			workerData: { sessionDirectory: resolvedDirectory },
			execArgv: workerExecArgv(),
		});
		const client = new SQLiteSessionStoreClient(resolvedDirectory, worker);
		try {
			client.storeInfo = (await client.call({ kind: "initialize" })) as SessionStoreInfo;
			return client;
		} catch (error) {
			client.closed = true;
			client.expectedExit = true;
			client.updateWorkerReference();
			evictSharedClient(client);
			await worker.terminate().catch(() => undefined);
			throw error;
		}
	}

	private readonly onMessage = (message: unknown): void => {
		let envelope: SessionStoreWorkerResponseEnvelope;
		try {
			envelope = parseSessionStoreWorkerResponseEnvelope(message);
		} catch (error) {
			this.failBoundary(
				new SessionStoreError("invalid_response", "Session store worker returned an invalid response", {
					cause: error,
				}),
			);
			return;
		}
		const pending = this.pending.get(envelope.requestId);
		if (!pending) {
			this.failBoundary(
				new SessionStoreError("invalid_response", "Session store worker returned an unknown request id"),
			);
			return;
		}
		this.pending.delete(envelope.requestId);
		this.updateWorkerReference();
		if (!envelope.ok) {
			pending.reject(new SessionStoreError(envelope.error.code, envelope.error.message));
			return;
		}
		try {
			const parsedJson = parseCanonicalSessionStoreJson(envelope.resultJson, "Session store worker response");
			pending.resolve(parseSessionStoreOperationResult(pending.kind, parsedJson));
		} catch (error) {
			const responseError = new SessionStoreError(
				"invalid_response",
				"Session store worker returned an invalid result",
				{ cause: error },
			);
			pending.reject(responseError);
			this.failBoundary(responseError);
		}
	};

	private readonly onError = (error: Error): void => {
		this.failBoundary(new SessionStoreError("worker_failed", "Session store worker failed", { cause: error }));
	};

	private readonly onExit = (code: number): void => {
		if (!this.expectedExit) {
			this.failBoundary(
				new SessionStoreError("worker_failed", `Session store worker exited unexpectedly with code ${code}`),
			);
		}
	};

	private attachWorkerListeners(): void {
		this.worker.on("message", this.onMessage);
		this.worker.on("error", this.onError);
		this.worker.on("exit", this.onExit);
	}

	private updateWorkerReference(): void {
		if (this.pending.size > 0) this.worker.ref();
		else this.worker.unref();
	}

	private failAll(error: SessionStoreError): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.updateWorkerReference();
	}

	private failBoundary(error: SessionStoreError): void {
		if (this.closed) return;
		this.closed = true;
		this.closing = false;
		this.expectedExit = true;
		this.failAll(error);
		evictSharedClient(this);
		void this.worker.terminate().catch(() => undefined);
	}

	private call(operation: SessionStoreWorkerOperation): Promise<unknown> {
		if (this.closed || (this.closing && operation.kind !== "close")) {
			return Promise.reject(new SessionStoreError("closed", "Session store is closed"));
		}
		let validated: SessionStoreWorkerOperation;
		try {
			validated = parseSessionStoreWorkerOperation(operation);
		} catch (error) {
			return Promise.reject(
				new SessionStoreError("invalid_request", "Invalid session store operation", { cause: error }),
			);
		}
		const requestId = this.nextRequestId;
		this.nextRequestId += 1;
		return new Promise<unknown>((resolveRequest, rejectRequest) => {
			this.pending.set(requestId, {
				kind: validated.kind,
				resolve: resolveRequest,
				reject: rejectRequest,
			});
			this.updateWorkerReference();
			try {
				this.worker.postMessage({
					requestId,
					operationJson: stringifyCanonicalSessionStoreJson(validated, "Session store operation"),
				});
			} catch (error) {
				this.pending.delete(requestId);
				this.updateWorkerReference();
				const requestError = new SessionStoreError(
					"worker_failed",
					"Could not send request to session store worker",
					{ cause: error },
				);
				rejectRequest(requestError);
				this.failBoundary(requestError);
			}
		});
	}

	async createHiddenSession(input: SessionStoreCreateSessionInput): Promise<SessionStoreSessionSummary> {
		return (await this.call({ kind: "create_session", input })) as SessionStoreSessionSummary;
	}

	async loadSession(sessionId: string, sessionGeneration: string): Promise<SessionStoreSnapshot | null> {
		return (await this.call({ kind: "load_session", sessionId, sessionGeneration })) as SessionStoreSnapshot | null;
	}

	async listSessionSummaries(options: SessionStoreListOptions = {}): Promise<SessionStoreSessionSummary[]> {
		return (await this.call({
			kind: "list_sessions",
			includeHidden: options.includeHidden ?? false,
			cwd: options.cwd ?? null,
		})) as SessionStoreSessionSummary[];
	}

	async findSessionSummaryById(sessionId: string): Promise<SessionStoreSessionSummary | null> {
		return (await this.call({ kind: "find_session_by_id", sessionId })) as SessionStoreSessionSummary | null;
	}

	async findSessionSummary(sessionId: string, sessionGeneration: string): Promise<SessionStoreSessionSummary | null> {
		return (await this.call({
			kind: "find_session",
			sessionId,
			sessionGeneration,
		})) as SessionStoreSessionSummary | null;
	}

	async searchSessionSummaries(
		query: string,
		options: SessionStoreListOptions = {},
	): Promise<SessionStoreSessionSummary[]> {
		return (await this.call({
			kind: "search_sessions",
			query,
			includeHidden: options.includeHidden ?? false,
			cwd: options.cwd ?? null,
		})) as SessionStoreSessionSummary[];
	}

	async applyTransaction(input: SessionStoreApplyTransactionInput): Promise<SessionStoreTransactionResult> {
		return (await this.call({ kind: "apply_transaction", input })) as SessionStoreTransactionResult;
	}

	async reconcileCommit(input: SessionStoreReconcileCommitInput): Promise<SessionStoreCommitReconciliation> {
		return (await this.call({ kind: "reconcile_commit", input })) as SessionStoreCommitReconciliation;
	}

	async deleteSession(input: SessionStoreDeleteSessionInput): Promise<SessionStoreDeleteSessionResult> {
		return (await this.call({ kind: "delete_session", input })) as SessionStoreDeleteSessionResult;
	}

	async importTransaction(input: SessionStoreImportTransactionInput): Promise<SessionStoreImportTransactionResult> {
		return (await this.call({ kind: "import_transaction", input })) as SessionStoreImportTransactionResult;
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) return;
		this.closing = true;
		evictSharedClient(this);
		this.closePromise = (async () => {
			try {
				await this.call({ kind: "close" });
			} finally {
				this.closed = true;
				this.closing = false;
				this.expectedExit = true;
				await this.worker.terminate().catch(() => undefined);
				this.failAll(new SessionStoreError("closed", "Session store is closed"));
				evictSharedClient(this);
			}
		})();
		return this.closePromise;
	}
}

function evictSharedClient(client: SQLiteSessionStoreClient): void {
	const entry = sharedStores.get(client.sessionDirectory);
	if (entry?.client === client) sharedStores.delete(client.sessionDirectory);
}

export function getSharedSQLiteSessionStore(sessionDirectory: string): Promise<SQLiteSessionStoreClient> {
	const resolvedDirectory = resolve(sessionDirectory);
	const existing = sharedStores.get(resolvedDirectory);
	if (existing) return existing.promise;

	const promise = SQLiteSessionStoreClient.open(resolvedDirectory)
		.then((client) => {
			const entry = sharedStores.get(resolvedDirectory);
			if (entry?.promise === promise) entry.client = client;
			return client;
		})
		.catch((error: unknown) => {
			if (sharedStores.get(resolvedDirectory)?.promise === promise) sharedStores.delete(resolvedDirectory);
			throw error;
		});
	sharedStores.set(resolvedDirectory, { promise });
	return promise;
}
