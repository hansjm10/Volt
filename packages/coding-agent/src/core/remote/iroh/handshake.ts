import {
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HANDSHAKE_TYPE,
	IROH_REMOTE_HELLO_TYPE,
	type IrohRemoteHostHandshakeFailureOutcome,
	type IrohRemoteOutcome,
	IrohRemoteOutcomeError,
	isIrohRemoteOutcome,
} from "./protocol.ts";

export interface IrohRemoteHello {
	type: typeof IROH_REMOTE_HELLO_TYPE;
	protocol: typeof IROH_REMOTE_ALPN;
	workspace: string;
	secret?: string;
	clientLabel?: string;
	clientNodeId?: string;
}

export interface IrohRemoteHandshakeSuccess {
	type: typeof IROH_REMOTE_HANDSHAKE_TYPE;
	success: true;
	workspace: string;
	hostNodeId?: string;
	clientNodeId: string;
	child?: string;
}

export interface IrohRemoteHandshakeFailure {
	type: typeof IROH_REMOTE_HANDSHAKE_TYPE;
	success: false;
	outcome?: IrohRemoteOutcome;
	hostNodeId?: string;
	error: string;
}

export type IrohRemoteHandshakeResponse = IrohRemoteHandshakeSuccess | IrohRemoteHandshakeFailure;

export function parseIrohRemoteHelloLine(line: string): IrohRemoteHello {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new Error(
			`Failed to parse Iroh remote handshake: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHello(parsed);
}

export function parseIrohRemoteHandshakeResponseLine(line: string): IrohRemoteHandshakeResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error: unknown) {
		throw new Error(
			`Failed to parse Iroh remote handshake response: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseIrohRemoteHandshakeResponse(parsed);
}

export function parseIrohRemoteHello(value: unknown): IrohRemoteHello {
	const hello = expectRecord(value, "Iroh remote handshake");
	if (hello.type !== IROH_REMOTE_HELLO_TYPE) {
		throw new Error("unexpected handshake type");
	}
	if (hello.protocol !== IROH_REMOTE_ALPN) {
		throw new Error(`unsupported protocol: ${typeof hello.protocol === "string" ? hello.protocol : "<missing>"}`);
	}

	return {
		type: IROH_REMOTE_HELLO_TYPE,
		protocol: IROH_REMOTE_ALPN,
		workspace: expectString(hello.workspace, "handshake workspace"),
		secret: expectOptionalString(hello.secret, "handshake secret"),
		clientLabel: expectOptionalString(hello.clientLabel, "handshake clientLabel"),
		clientNodeId: expectOptionalString(hello.clientNodeId, "handshake clientNodeId"),
	};
}

export function parseIrohRemoteHandshakeResponse(value: unknown): IrohRemoteHandshakeResponse {
	const response = expectRecord(value, "Iroh remote handshake response");
	if (response.type !== IROH_REMOTE_HANDSHAKE_TYPE) {
		throw new Error("unexpected handshake response type");
	}
	if (response.success === true) {
		const hostNodeId = expectOptionalString(response.hostNodeId, "handshake response hostNodeId");
		const success: IrohRemoteHandshakeSuccess = {
			type: IROH_REMOTE_HANDSHAKE_TYPE,
			success: true,
			workspace: expectString(response.workspace, "handshake response workspace"),
			clientNodeId: expectString(response.clientNodeId, "handshake response clientNodeId"),
			child: expectOptionalString(response.child, "handshake response child"),
		};
		return hostNodeId === undefined ? success : { ...success, hostNodeId };
	}
	if (response.success === false) {
		const outcome = expectOptionalOutcome(response.outcome, "handshake response outcome");
		const hostNodeId = expectOptionalString(response.hostNodeId, "handshake response hostNodeId");
		const failure: IrohRemoteHandshakeFailure = {
			type: IROH_REMOTE_HANDSHAKE_TYPE,
			success: false,
			error: expectString(response.error, "handshake response error"),
		};
		return {
			...failure,
			...(outcome === undefined ? {} : { outcome }),
			...(hostNodeId === undefined ? {} : { hostNodeId }),
		};
	}
	throw new Error("handshake response success must be a boolean");
}

export function createIrohRemoteHandshakeSuccess(options: {
	workspace: string;
	hostNodeId?: string;
	clientNodeId: string;
	child?: string;
}): IrohRemoteHandshakeSuccess {
	const response: IrohRemoteHandshakeSuccess = {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: true,
		workspace: options.workspace,
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		clientNodeId: options.clientNodeId,
		child: options.child,
	};
	return response;
}

export function createIrohRemoteHandshakeFailure(
	error: string,
	options: { hostNodeId?: string; outcome?: IrohRemoteHostHandshakeFailureOutcome } = {},
): IrohRemoteHandshakeFailure {
	return {
		type: IROH_REMOTE_HANDSHAKE_TYPE,
		success: false,
		...(options.outcome === undefined ? {} : { outcome: options.outcome }),
		...(options.hostNodeId === undefined ? {} : { hostNodeId: options.hostNodeId }),
		error,
	};
}

export function assertIrohRemoteHandshakeHostIdentity(
	response: IrohRemoteHandshakeResponse,
	expectedHostNodeId: string | undefined,
): void {
	if (expectedHostNodeId === undefined) {
		return;
	}
	const actualHostNodeId = response.hostNodeId;
	if (actualHostNodeId !== expectedHostNodeId) {
		throw new IrohRemoteOutcomeError(
			"host_identity_mismatch",
			`expected ${expectedHostNodeId}, got ${actualHostNodeId ?? "<missing>"}`,
		);
	}
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectString(value, label);
}

function expectOptionalOutcome(value: unknown, label: string): IrohRemoteOutcome | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isIrohRemoteOutcome(value)) {
		throw new Error(`${label} must be a known Iroh remote outcome`);
	}
	return value;
}
