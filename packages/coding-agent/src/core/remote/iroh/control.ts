import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type IrohRemoteRelayMode, isIrohRemoteRelayMode } from "./protocol.ts";

export const IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE = "volt_iroh_pair_request";
export const IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE = "volt_iroh_pair_response";
export const IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE = "volt_iroh_revoke_request";
export const IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE = "volt_iroh_revoke_response";
export const DEFAULT_IROH_REMOTE_CONTROL_TIMEOUT_MS = 5_000;

const DEFAULT_IROH_REMOTE_CONTROL_ACTIVE_RETRY_ATTEMPTS = 10;
const DEFAULT_IROH_REMOTE_CONTROL_ACTIVE_RETRY_DELAY_MS = 250;
const IROH_REMOTE_CONTROL_ROOT_DIR = "volt-iroh-remote";

export type IrohRemoteUnsafeApproval = "tty_confirmation" | "yes_flag";

export interface IrohRemotePairControlRequest {
	type: typeof IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE;
	allowTools?: string;
	labelHint?: string;
	relayMode?: IrohRemoteRelayMode;
	ttlMs?: number;
	unsafeApproval?: IrohRemoteUnsafeApproval;
	workspace: string;
}

export interface IrohRemoteRevokeControlRequest {
	type: typeof IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE;
	nodeId: string;
}

export type IrohRemoteControlRequest = IrohRemotePairControlRequest | IrohRemoteRevokeControlRequest;

export type IrohRemotePairControlResponse =
	| {
			type: typeof IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
			success: true;
			expiresAt: number;
			ticket: string;
	  }
	| {
			type: typeof IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE;
			success: false;
			error: string;
	  };

export type IrohRemoteRevokeControlResponse =
	| {
			type: typeof IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE;
			success: true;
			closed: boolean;
			closedCount: number;
	  }
	| {
			type: typeof IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE;
			success: false;
			error: string;
	  };

export interface IrohRemoteControlClientOptions<Request extends IrohRemoteControlRequest> {
	request: Request;
	statePath: string;
	timeoutMs?: number;
}

export interface IrohRemoteControlServerListenOptions {
	activeRetryAttempts?: number;
	activeRetryDelayMs?: number;
}

export type IrohRemotePairControlClientOptions = IrohRemoteControlClientOptions<IrohRemotePairControlRequest>;
export type IrohRemoteRevokeControlClientOptions = IrohRemoteControlClientOptions<IrohRemoteRevokeControlRequest>;

export function getIrohRemoteControlPath(statePath: string): string {
	const hash = createHash("sha256").update(statePath).digest("hex").slice(0, 32);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\volt-iroh-remote-${hash}`;
	}
	return join(tmpdir(), IROH_REMOTE_CONTROL_ROOT_DIR, hash, "control.sock");
}

export async function ensureIrohRemoteControlDirectory(controlPath: string): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const controlDir = dirname(controlPath);
	const controlRootDir = dirname(controlDir);
	if (basename(controlRootDir) === IROH_REMOTE_CONTROL_ROOT_DIR) {
		await ensureOwnerOnlyIrohRemoteControlDirectory(controlRootDir);
	}
	await ensureOwnerOnlyIrohRemoteControlDirectory(controlDir);
}

export async function listenIrohRemoteControlServer(
	server: Server,
	controlPath: string,
	options: IrohRemoteControlServerListenOptions = {},
): Promise<void> {
	await ensureIrohRemoteControlDirectory(controlPath);
	const activeRetryAttempts = options.activeRetryAttempts ?? DEFAULT_IROH_REMOTE_CONTROL_ACTIVE_RETRY_ATTEMPTS;
	const activeRetryDelayMs = options.activeRetryDelayMs ?? DEFAULT_IROH_REMOTE_CONTROL_ACTIVE_RETRY_DELAY_MS;
	for (let attempt = 0; ; attempt += 1) {
		try {
			await listenServer(server, controlPath);
			return;
		} catch (error) {
			if (process.platform === "win32" || !(error instanceof Error) || !isNodeErrorCode(error, "EADDRINUSE")) {
				throw error;
			}
			if (await canConnectToControlPath(controlPath)) {
				if (attempt < activeRetryAttempts) {
					await delay(activeRetryDelayMs);
					continue;
				}
				throw new Error(`Iroh remote host control channel is already active for this state path: ${controlPath}`);
			}
			await rm(controlPath, { force: true });
		}
	}
}

function listenServer(server: Server, controlPath: string): Promise<void> {
	return new Promise((resolveListen, rejectListen) => {
		const cleanup = () => {
			server.off("error", handleError);
			server.off("listening", handleListening);
		};
		const handleError = (error: Error) => {
			cleanup();
			rejectListen(error);
		};
		const handleListening = () => {
			cleanup();
			resolveListen();
		};
		server.once("error", handleError);
		server.once("listening", handleListening);
		try {
			server.listen(controlPath);
		} catch (error) {
			cleanup();
			rejectListen(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function canConnectToControlPath(controlPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = connect(controlPath);
		let settled = false;
		const finish = (canConnect: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveConnect(canConnect);
		};
		const timeout = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, ms);
	});
}

function isNodeErrorCode(error: Error, code: string): boolean {
	return "code" in error && error.code === code;
}

async function ensureOwnerOnlyIrohRemoteControlDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const pathStat = await lstat(path);
	if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
		throw new Error(`Iroh remote host control directory is not a directory: ${path}`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && pathStat.uid !== currentUid) {
		throw new Error(`Iroh remote host control directory is owned by another user: ${path}`);
	}
	if ((pathStat.mode & 0o777) !== 0o700) {
		await chmod(path, 0o700);
	}
}

export function parseIrohRemoteControlRequest(value: unknown): IrohRemoteControlRequest {
	const request = expectRecord(value, "Iroh remote control request");
	const type = expectString(request.type, "control request type");
	if (type === IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE) {
		return parseIrohRemotePairControlRequestRecord(request);
	}
	if (type === IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE) {
		return parseIrohRemoteRevokeControlRequestRecord(request);
	}
	throw new Error(`Unsupported Iroh remote control request type: ${type}`);
}

export function parseIrohRemotePairControlRequest(value: unknown): IrohRemotePairControlRequest {
	return parseIrohRemotePairControlRequestRecord(expectRecord(value, "Iroh remote pair control request"));
}

function parseIrohRemotePairControlRequestRecord(request: Record<string, unknown>): IrohRemotePairControlRequest {
	const type = expectString(request.type, "pair control request type");
	if (type !== IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE) {
		throw new Error(`Unsupported Iroh remote pair control request type: ${type}`);
	}
	const relayMode = expectOptionalRelayMode(request.relayMode, "pair control request relayMode");
	const unsafeApproval = expectOptionalUnsafeApproval(request.unsafeApproval, "pair control request unsafeApproval");
	const allowTools = expectOptionalString(request.allowTools, "pair control request allowTools");
	const labelHint = expectOptionalString(request.labelHint, "pair control request labelHint");
	const ttlMs = expectOptionalPositiveNumber(request.ttlMs, "pair control request ttlMs");
	return {
		type: IROH_REMOTE_PAIR_CONTROL_REQUEST_TYPE,
		workspace: expectString(request.workspace, "pair control request workspace"),
		...(allowTools === undefined ? {} : { allowTools }),
		...(labelHint === undefined ? {} : { labelHint }),
		...(relayMode === undefined ? {} : { relayMode }),
		...(ttlMs === undefined ? {} : { ttlMs }),
		...(unsafeApproval === undefined ? {} : { unsafeApproval }),
	};
}

export function parseIrohRemoteRevokeControlRequest(value: unknown): IrohRemoteRevokeControlRequest {
	return parseIrohRemoteRevokeControlRequestRecord(expectRecord(value, "Iroh remote revoke control request"));
}

function parseIrohRemoteRevokeControlRequestRecord(request: Record<string, unknown>): IrohRemoteRevokeControlRequest {
	const type = expectString(request.type, "revoke control request type");
	if (type !== IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE) {
		throw new Error(`Unsupported Iroh remote revoke control request type: ${type}`);
	}
	return {
		type: IROH_REMOTE_REVOKE_CONTROL_REQUEST_TYPE,
		nodeId: expectString(request.nodeId, "revoke control request nodeId"),
	};
}

export function parseIrohRemotePairControlResponse(value: unknown): IrohRemotePairControlResponse {
	const response = expectRecord(value, "Iroh remote pair control response");
	const type = expectString(response.type, "pair control response type");
	if (type !== IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE) {
		throw new Error(`Unsupported Iroh remote control response type: ${type}`);
	}
	const success = expectBoolean(response.success, "pair control response success");
	if (!success) {
		return {
			type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
			success: false,
			error: expectString(response.error, "pair control response error"),
		};
	}
	const expiresAt = expectPositiveNumber(response.expiresAt, "pair control response expiresAt");
	return {
		type: IROH_REMOTE_PAIR_CONTROL_RESPONSE_TYPE,
		success: true,
		expiresAt,
		ticket: expectString(response.ticket, "pair control response ticket"),
	};
}

export function parseIrohRemoteRevokeControlResponse(value: unknown): IrohRemoteRevokeControlResponse {
	const response = expectRecord(value, "Iroh remote revoke control response");
	const type = expectString(response.type, "revoke control response type");
	if (type !== IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE) {
		throw new Error(`Unsupported Iroh remote revoke control response type: ${type}`);
	}
	const success = expectBoolean(response.success, "revoke control response success");
	if (!success) {
		return {
			type: IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
			success: false,
			error: expectString(response.error, "revoke control response error"),
		};
	}
	return {
		type: IROH_REMOTE_REVOKE_CONTROL_RESPONSE_TYPE,
		success: true,
		closed: expectBoolean(response.closed, "revoke control response closed"),
		closedCount: expectNonNegativeNumber(response.closedCount, "revoke control response closedCount"),
	};
}

export async function requestIrohRemotePairingTicket(
	options: IrohRemotePairControlClientOptions,
): Promise<IrohRemotePairControlResponse> {
	return await requestIrohRemoteControl(options, parseIrohRemotePairControlResponse);
}

export async function requestIrohRemoteActiveRevocation(
	options: IrohRemoteRevokeControlClientOptions,
): Promise<IrohRemoteRevokeControlResponse> {
	return await requestIrohRemoteControl(options, parseIrohRemoteRevokeControlResponse);
}

async function requestIrohRemoteControl<Response>(
	options: IrohRemoteControlClientOptions<IrohRemoteControlRequest>,
	parseResponse: (value: unknown) => Response,
): Promise<Response> {
	const controlPath = getIrohRemoteControlPath(options.statePath);
	const timeoutMs = options.timeoutMs ?? DEFAULT_IROH_REMOTE_CONTROL_TIMEOUT_MS;
	const socket = connect(controlPath);
	socket.setEncoding("utf8");

	return await new Promise<Response>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const timeout = setTimeout(() => {
			finish(undefined, new Error("Timed out waiting for a running Iroh remote host control response"));
		}, timeoutMs);

		const finish = (response?: Response, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error) {
				reject(error);
				return;
			}
			if (!response) {
				reject(new Error("Iroh remote host control channel closed without a response"));
				return;
			}
			resolve(response);
		};

		socket.once("connect", () => {
			socket.write(`${JSON.stringify(options.request)}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			try {
				finish(parseResponse(JSON.parse(buffer.slice(0, newlineIndex))));
			} catch (error) {
				finish(undefined, error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => {
			finish(undefined, new Error(`No running Iroh remote host control channel is available (${error.message})`));
		});
		socket.once("end", () => finish());
	});
}

function expectRecord(value: unknown, description: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${description} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, description: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${description} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, description: string): string | undefined {
	if (value === undefined) return undefined;
	return expectString(value, description);
}

function expectBoolean(value: unknown, description: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${description} must be a boolean`);
	}
	return value;
}

function expectPositiveNumber(value: unknown, description: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${description} must be a positive number`);
	}
	return value;
}

function expectNonNegativeNumber(value: unknown, description: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${description} must be a non-negative number`);
	}
	return value;
}

function expectOptionalPositiveNumber(value: unknown, description: string): number | undefined {
	if (value === undefined) return undefined;
	return expectPositiveNumber(value, description);
}

function expectOptionalRelayMode(value: unknown, description: string): IrohRemoteRelayMode | undefined {
	if (value === undefined) return undefined;
	if (!isIrohRemoteRelayMode(value)) {
		throw new Error(`${description} must be disabled or default`);
	}
	return value;
}

function expectOptionalUnsafeApproval(value: unknown, description: string): IrohRemoteUnsafeApproval | undefined {
	if (value === undefined) return undefined;
	if (value !== "tty_confirmation" && value !== "yes_flag") {
		throw new Error(`${description} must be tty_confirmation or yes_flag`);
	}
	return value;
}
