import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@hansjm10/volt-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import {
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	parseIrohRemoteHandshakeResponse,
} from "../src/core/remote/iroh/handshake.ts";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import { decodeIrohRemoteTicketPayload } from "../src/core/remote/iroh/ticket.ts";
import type { IrohBiStreamLike } from "../src/core/rpc/iroh-transport.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import { CONTROL_RPC_GRANTS_CAPABILITY, type ControlEvent } from "../src/daemon/control-protocol.ts";
import { createIntegratedConversationHandshakeResponse } from "../src/daemon/handshake-responses.ts";
import {
	formatIrohLoadError,
	type IrohConnectionLike,
	type IrohEndpointLike,
	type IrohHomeRelayWatchCallback,
	type IrohIncomingLike,
	type IrohRelayConfigLike,
	loadIrohModule,
} from "../src/daemon/iroh-native.ts";
import { DEFAULT_IROH_REMOTE_RESOURCE_LIMITS } from "../src/daemon/iroh-resource-guard.ts";
import {
	createIrohDaemonService,
	IrohDaemonAdmissionGate,
	IrohPhysicalStreamOwner,
	resolveIrohRelayConfig,
	resolveIrohRelayCredentialServiceUrl,
	VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
	VOLT_CANARY_RELAY_URLS,
	VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
	VOLT_PRODUCTION_RELAY_URLS,
} from "../src/daemon/iroh-service.ts";
import {
	createLifecycleFencedIrohStream,
	IrohStreamLifecycleClosedError,
} from "../src/daemon/iroh-stream-lifecycle.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import type { IrohManagedRelayCredential } from "../src/daemon/relay-credential.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";
import { readLineFromIroh } from "../src/daemon/workspace-streams.ts";

const native = loadIrohModule();
const nativeAvailable = native.iroh !== undefined;
const nativeRequired = process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1";

describe("native Iroh test prerequisite", () => {
	it("loads the native adapter when required", () => {
		if (nativeRequired && !native.iroh) {
			throw new Error(formatIrohLoadError(native.error));
		}
	});

	it("loads explicit connected-watcher and relay-reconnect capabilities", () => {
		expect(native.capabilities).toEqual({ connectedHomeRelayWatch: true, reconnectRelay: true });
	});
});

interface PhoneEndpoint {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnection>;
	close(): Promise<void>;
}

interface PhoneBiStream extends IrohBiStreamLike {
	send: IrohBiStreamLike["send"] & {
		finish(): Promise<void>;
		stopped(): Promise<number | null>;
	};
}

interface PhoneConnection {
	remoteId(): { toString(): string };
	openBi(): Promise<PhoneBiStream>;
	closed(): Promise<string>;
	close(code: bigint, reason: number[]): void;
}

const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

async function waitForHealthyDaemon(agentDir: string): Promise<DaemonProbeResult> {
	let status = await probeDaemon(agentDir);
	for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		status = await probeDaemon(agentDir);
	}
	expect(status.healthy).toBe(true);
	return status;
}

async function expectIrohEndpointReady(control: DaemonClient): Promise<void> {
	const response = await control.request({ type: "client_revoke", clientNodeId: "f".repeat(64) });
	expect(response).toMatchObject({ type: "error", code: "not_found" });
}

function withRecordedRelayCredentialInstall(
	endpoint: IrohEndpointLike,
	reconnects: IrohRelayConfigLike[],
	onClose: () => void,
	removals?: string[],
	mutations?: string[],
	beforeReconnect?: () => void | Promise<void>,
): IrohEndpointLike {
	let watcher: IrohHomeRelayWatchCallback | undefined;
	return {
		id: () => endpoint.id(),
		addr: () => endpoint.addr(),
		online: () => Promise.resolve(),
		insertRelay: (config) => endpoint.insertRelay?.(config) ?? Promise.resolve(),
		reconnectRelay: async (config) => {
			await beforeReconnect?.();
			mutations?.push(`reconnect:${config.url}`);
			reconnects.push(config);
			watcher?.(null, [config.url]);
		},
		removeRelay: async (url) => {
			mutations?.push(`remove:${url}`);
			removals?.push(url);
			return (await endpoint.removeRelay?.(url)) ?? false;
		},
		watchHomeRelay: (callback) => {
			watcher = callback;
			return {
				async stop() {
					watcher = undefined;
				},
			};
		},
		acceptNext: () => endpoint.acceptNext(),
		secretKey: () => endpoint.secretKey(),
		async close() {
			onClose();
			await endpoint.close();
		},
	};
}

async function provisionManagedRelayCredentialState(
	agentDir: string,
	accessTokenLifetimeMs: number,
): Promise<IrohManagedRelayCredential> {
	let hostNodeId: string | undefined;
	let control: DaemonClient | undefined;
	let daemonStopped = false;
	const daemon = runVoltDaemon({ agentDir, foreground: false }, [
		createIrohDaemonService(
			{ relayMode: "disabled" },
			{
				decorateEndpoint: (endpoint) => {
					hostNodeId = endpoint.id().toString();
					return endpoint;
				},
			},
		),
	]);
	try {
		const status = await waitForHealthyDaemon(agentDir);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await expectIrohEndpointReady(control);
		expect(hostNodeId).toMatch(/^[0-9a-f]{64}$/);
		expect((await control.request({ type: "shutdown" })).type).toBe("ok");
		await daemon;
		daemonStopped = true;
	} finally {
		if (!daemonStopped) {
			await control?.request({ type: "shutdown" }).catch(() => {});
			await daemon;
		}
		await control?.close();
	}
	if (hostNodeId === undefined) throw new Error("provisioned Iroh endpoint identity is missing");
	const credential: IrohManagedRelayCredential = {
		schemaVersion: 2,
		serviceUrl: VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		relayUrls: [...VOLT_PRODUCTION_RELAY_URLS],
		endpointNodeId: hostNodeId,
		endpointId: "endpoint-unit-test",
		grantId: "grant-unit-test-id",
		accessToken: "header.payload.signature",
		accessTokenExpiresAt: Date.now() + accessTokenLifetimeMs,
		refreshToken: `vrr_${"r".repeat(43)}`,
	};
	const statePath = getDaemonPaths(agentDir).statePath;
	const state = JSON.parse(readFileSync(statePath, "utf8")) as { settings: Record<string, unknown> };
	state.settings.relayCredential = credential;
	delete state.settings.relayAuthToken;
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	return credential;
}

function persistCanaryManagedRelayAuthority(
	agentDir: string,
	credential: IrohManagedRelayCredential,
	authority: "credential" | "claim" | "revocation",
	serviceUrl: string,
): void {
	const statePath = getDaemonPaths(agentDir).statePath;
	const state = JSON.parse(readFileSync(statePath, "utf8")) as { settings: Record<string, unknown> };
	delete state.settings.relayAuthToken;
	delete state.settings.relayCredential;
	delete state.settings.relayCredentialClaim;
	delete state.settings.relayCredentialRevocation;
	const canaryCredential = {
		...credential,
		serviceUrl,
		relayUrls: [...VOLT_CANARY_RELAY_URLS],
	};
	if (authority === "credential") {
		state.settings.relayCredential = canaryCredential;
	} else if (authority === "revocation") {
		state.settings.relayCredentialRevocation = canaryCredential;
	} else {
		state.settings.relayCredentialClaim = {
			schemaVersion: 1,
			serviceUrl,
			relayUrls: [...VOLT_CANARY_RELAY_URLS],
			hostNodeId: credential.endpointNodeId,
			claimSecret: `vpc_${"c".repeat(43)}`,
			bootstrapRefreshToken: credential.refreshToken,
			claimId: "claimabcdefghijklmnopqrs",
			expiresAt: Date.now() + 10 * 60_000,
		};
	}
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function captureIrohStartupError(
	agentDir: string,
	config: Parameters<typeof createIrohDaemonService>[0] = {},
): Promise<{ error: string | undefined; endpointDecorations: number }> {
	let startupError: string | undefined;
	let endpointDecorations = 0;
	let daemonStopped = false;
	let control: DaemonClient | undefined;
	const irohService = createIrohDaemonService(config, {
		decorateEndpoint: (endpoint) => {
			endpointDecorations++;
			return withRecordedRelayCredentialInstall(endpoint, [], () => {});
		},
	});
	const daemon = runVoltDaemon({ agentDir, foreground: false }, [
		(services) => {
			try {
				return irohService(services);
			} catch (error) {
				startupError = error instanceof Error ? error.message : String(error);
				return {};
			}
		},
	]);
	try {
		const status = await waitForHealthyDaemon(agentDir);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await control.request({ type: "shutdown" });
		await daemon;
		daemonStopped = true;
		return { error: startupError, endpointDecorations };
	} finally {
		if (!daemonStopped) {
			await control?.request({ type: "shutdown" }).catch(() => {});
			await daemon;
		}
		await control?.close();
	}
}

async function createPhoneEndpoint(): Promise<PhoneEndpoint> {
	const iroh = native.iroh;
	if (!iroh) {
		throw new Error("native iroh unavailable");
	}
	const builder = iroh.Endpoint.builder();
	iroh.presetMinimal(builder);
	builder.relayMode(iroh.RelayMode.disabled());
	const endpoint = (await builder.bind()) as unknown as PhoneEndpoint;
	return endpoint;
}

function withStalledClose(endpoint: IrohEndpointLike): IrohEndpointLike {
	return {
		id: () => endpoint.id(),
		addr: () => endpoint.addr(),
		online: () => endpoint.online(),
		acceptNext: () => endpoint.acceptNext(),
		secretKey: () => endpoint.secretKey(),
		async close() {
			// Begin the real native close so live transports retire, then reproduce
			// the observed native promise that never reports terminal settlement.
			void endpoint.close().catch(() => {});
			await new Promise<void>(() => {});
		},
	};
}

function withStalledOnline(
	endpoint: IrohEndpointLike,
	onlineStarted: () => void,
	onlineGate: Promise<void>,
): IrohEndpointLike {
	return {
		id: () => endpoint.id(),
		addr: () => endpoint.addr(),
		async online() {
			onlineStarted();
			await onlineGate;
		},
		...(endpoint.insertRelay === undefined ? {} : { insertRelay: endpoint.insertRelay.bind(endpoint) }),
		...(endpoint.reconnectRelay === undefined ? {} : { reconnectRelay: endpoint.reconnectRelay.bind(endpoint) }),
		...(endpoint.removeRelay === undefined ? {} : { removeRelay: endpoint.removeRelay.bind(endpoint) }),
		...(endpoint.watchHomeRelay === undefined ? {} : { watchHomeRelay: endpoint.watchHomeRelay.bind(endpoint) }),
		acceptNext: () => endpoint.acceptNext(),
		secretKey: () => endpoint.secretKey(),
		close: () => endpoint.close(),
	};
}

function withInjectedIncomings(endpoint: IrohEndpointLike, incomings: readonly IrohIncomingLike[]): IrohEndpointLike {
	let nextIncoming = 0;
	return {
		id: () => endpoint.id(),
		addr: () => endpoint.addr(),
		online: () => endpoint.online(),
		acceptNext: () => {
			if (nextIncoming < incomings.length) {
				return Promise.resolve(incomings[nextIncoming++]);
			}
			return endpoint.acceptNext();
		},
		secretKey: () => endpoint.secretKey(),
		close: () => endpoint.close(),
	};
}

function withDeferredIncoming(
	endpoint: IrohEndpointLike,
	incomingReady: Promise<void>,
	onAcceptStarted: () => void,
	incoming: IrohIncomingLike,
): IrohEndpointLike {
	let delivered = false;
	return {
		id: () => endpoint.id(),
		addr: () => endpoint.addr(),
		online: () => endpoint.online(),
		async acceptNext() {
			if (!delivered) {
				delivered = true;
				onAcceptStarted();
				await incomingReady;
				return incoming;
			}
			return endpoint.acceptNext();
		},
		secretKey: () => endpoint.secretKey(),
		close: () => endpoint.close(),
	};
}

function withStalledRead(
	stream: IrohBiStreamLike,
	onReadStarted: () => void,
	readGate: Promise<void>,
): IrohBiStreamLike {
	return {
		recv: {
			async read() {
				onReadStarted();
				await readGate;
				return undefined;
			},
			...(stream.recv.stop === undefined ? {} : { stop: (errorCode: bigint) => stream.recv.stop?.(errorCode) }),
		},
		send: stream.send,
	};
}

function withGatedUnregisterResponse(
	stream: IrohBiStreamLike,
	onWriteStarted: () => void,
	writeGate: Promise<void>,
): IrohBiStreamLike {
	let gated = false;
	const finish = stream.send.finish?.bind(stream.send);
	const reset = stream.send.reset?.bind(stream.send);
	return {
		recv: stream.recv,
		send: {
			async writeAll(bytes) {
				const line = Buffer.from(bytes).toString("utf8");
				if (!gated && line.includes('"command":"unregister_workspace"') && line.includes('"success":true')) {
					gated = true;
					onWriteStarted();
					await writeGate;
				}
				await stream.send.writeAll(bytes);
			},
			...(finish === undefined ? {} : { finish }),
			...(reset === undefined ? {} : { reset }),
		},
	};
}

async function writeJsonLine(stream: IrohBiStreamLike, value: object): Promise<void> {
	await stream.send.writeAll(Array.from(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")));
}

async function readJsonLine(
	stream: IrohBiStreamLike,
	rest: Buffer = Buffer.alloc(0),
): Promise<{ value: Record<string, unknown>; rest: Buffer }> {
	const result = await readLineFromIroh(stream.recv, rest, { maxLineBytes: 1024 * 1024 });
	if (result.line === undefined) {
		throw new Error("stream ended before a line was received");
	}
	return { value: JSON.parse(result.line) as Record<string, unknown>, rest: result.rest };
}

async function readJsonLineMatching(
	stream: IrohBiStreamLike,
	rest: Buffer,
	predicate: (value: Record<string, unknown>) => boolean,
): Promise<{ value: Record<string, unknown>; rest: Buffer }> {
	let buffered = rest;
	while (true) {
		const result = await readJsonLine(stream, buffered);
		if (predicate(result.value)) {
			return result;
		}
		buffered = result.rest;
	}
}

describe("relay config resolution", () => {
	it("defaults to the Volt production relays", () => {
		expect(resolveIrohRelayConfig({}, {})).toEqual({
			relayMode: "production",
			relayUrls: VOLT_PRODUCTION_RELAY_URLS,
		});
	});

	it("binds each built-in relay deployment to its exact managed broker origin", () => {
		expect(VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL).toBe("https://credentials.volt-cli.dev");
		expect(VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL).toBe("https://credentials-canary.volt-cli.dev");
		expect(resolveIrohRelayCredentialServiceUrl("production", VOLT_PRODUCTION_RELAY_URLS)).toBe(
			VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		);
		expect(resolveIrohRelayCredentialServiceUrl("production", VOLT_CANARY_RELAY_URLS)).toBe(
			VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
		);
		expect(
			resolveIrohRelayCredentialServiceUrl(
				"production",
				VOLT_PRODUCTION_RELAY_URLS,
				`${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/`,
			),
		).toBe(VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL);
		expect(
			resolveIrohRelayCredentialServiceUrl(
				"production",
				VOLT_CANARY_RELAY_URLS,
				VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
			),
		).toBe(VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL);
	});

	it("rejects explicit broker origins that conflict with a built-in relay deployment", () => {
		expect(() =>
			resolveIrohRelayCredentialServiceUrl(
				"production",
				VOLT_PRODUCTION_RELAY_URLS,
				VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
			),
		).toThrowError("explicit managed relay credential service URL conflicts with the production relay deployment");
		expect(() =>
			resolveIrohRelayCredentialServiceUrl(
				"production",
				VOLT_CANARY_RELAY_URLS,
				VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
			),
		).toThrowError("explicit managed relay credential service URL conflicts with the canary relay deployment");
		expect(() =>
			resolveIrohRelayCredentialServiceUrl(
				"production",
				VOLT_PRODUCTION_RELAY_URLS,
				"https://credentials.volt-cli.dev:8443",
			),
		).toThrowError("explicit managed relay credential service URL conflicts with the production relay deployment");
	});

	it("does not assign a managed broker to self-managed or disabled relay sets", () => {
		expect(resolveIrohRelayCredentialServiceUrl("production", ["https://self-managed.example.com"])).toBeUndefined();
		expect(
			resolveIrohRelayCredentialServiceUrl(
				"production",
				["https://self-managed.example.com"],
				VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
			),
		).toBeUndefined();
		expect(resolveIrohRelayCredentialServiceUrl("disabled", VOLT_PRODUCTION_RELAY_URLS)).toBeUndefined();
	});

	it("uses VOLT_IROH_RELAY_URLS for a self-managed relay fleet", () => {
		expect(
			resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_URLS: " https://r1.example.com , https://r2.example.com ," }),
		).toEqual({
			relayMode: "production",
			relayUrls: ["https://r1.example.com", "https://r2.example.com"],
		});
	});

	it("retains persisted managed relay origins across daemon restarts", () => {
		expect(resolveIrohRelayConfig({}, {}, VOLT_CANARY_RELAY_URLS)).toEqual({
			relayMode: "production",
			relayUrls: VOLT_CANARY_RELAY_URLS,
		});
		expect(
			resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_URLS: "https://explicit.example.com" }, VOLT_CANARY_RELAY_URLS),
		).toEqual({ relayMode: "production", relayUrls: ["https://explicit.example.com"] });
	});

	it("opts into the n0 public relays only via VOLT_IROH_RELAY_MODE=development", () => {
		expect(resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "development" })).toEqual({
			relayMode: "development",
			relayUrls: [],
		});
		expect(resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "disabled" })).toEqual({
			relayMode: "disabled",
			relayUrls: [],
		});
	});

	it("prefers explicit service config over the environment", () => {
		expect(
			resolveIrohRelayConfig(
				{ relayMode: "disabled" },
				{ VOLT_IROH_RELAY_MODE: "development", VOLT_IROH_RELAY_URLS: "https://ignored.example.com" },
			),
		).toEqual({ relayMode: "disabled", relayUrls: ["https://ignored.example.com"] });
		expect(
			resolveIrohRelayConfig(
				{ relayUrls: ["https://config.example.com"] },
				{ VOLT_IROH_RELAY_URLS: "https://env.example.com" },
			),
		).toEqual({ relayMode: "production", relayUrls: ["https://config.example.com"] });
	});

	it("warns on an invalid VOLT_IROH_RELAY_MODE and falls back to the default", () => {
		const resolved = resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "n0" });
		expect(resolved.relayMode).toBe("production");
		expect(resolved.relayUrls).toEqual(VOLT_PRODUCTION_RELAY_URLS);
		expect(resolved.warning).toContain("VOLT_IROH_RELAY_MODE");
	});
});

describe.skipIf(!nativeAvailable)("voltd Iroh relay restart recovery", () => {
	it("recycles a lost relay registration without replacing identity or credential authority", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-relay-recovery-"));
		const relayUrl = "https://relay-recovery.example.com";
		const relayAuthToken = "unit-test-relay-token";
		const relayReconnects: IrohRelayConfigLike[] = [];
		const controlEvents: ControlEvent[] = [];
		let emitRelayUrl: ((url: string | null) => void) | undefined;
		let endpointCloseCalls = 0;
		let watchStopped = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{ relayUrls: [relayUrl], relayAuthToken },
				{
					relayWatchApiSafe: true,
					relayReconnectApiSafe: true,
					relayRecoveryDelayMs: 20,
					relayRecoveryRetryMs: 20,
					relayRecoveryConfirmationTimeoutMs: 20,
					decorateEndpoint: (endpoint) => {
						let watcher: IrohHomeRelayWatchCallback | undefined;
						emitRelayUrl = (url) => watcher?.(null, url === null ? [] : [url]);
						return {
							id: () => endpoint.id(),
							addr: () => endpoint.addr(),
							online: () => Promise.resolve(),
							reconnectRelay: async (config) => {
								relayReconnects.push(config);
								watcher?.(null, [config.url]);
							},
							watchHomeRelay: (callback) => {
								watcher = callback;
								return {
									async stop() {
										watcher = undefined;
										watchStopped = true;
									},
								};
							},
							acceptNext: () => endpoint.acceptNext(),
							secretKey: () => endpoint.secretKey(),
							async close() {
								endpointCloseCalls++;
								await endpoint.close();
							},
						};
					},
				},
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
				onEvent: (event) => controlEvents.push(event),
			});
			const pairAndReadNodeId = async (): Promise<string> => {
				const started = await control?.request({ type: "pair_request" });
				if (started?.type !== "pair_started") throw new Error("pair request did not start");
				let ticket: string | undefined;
				await expect
					.poll(() => {
						const event = controlEvents.find(
							(candidate) =>
								candidate.type === "pairing_progress" &&
								candidate.requestId === started.requestId &&
								candidate.phase === "ticket",
						);
						ticket = event?.type === "pairing_progress" ? event.ticket : undefined;
						return ticket;
					})
					.toBeTypeOf("string");
				expect(await control?.request({ type: "pair_cancel", requestId: started.requestId })).toMatchObject({
					type: "ok",
				});
				const nodeId = decodeIrohRemoteTicketPayload(ticket as string).nodeId;
				if (nodeId === undefined) throw new Error("pairing ticket node id missing");
				return nodeId;
			};

			const nodeIdBeforeLoss = await pairAndReadNodeId();
			emitRelayUrl?.(relayUrl);
			emitRelayUrl?.(null);
			await expect.poll(() => relayReconnects.length).toBe(1);
			expect(relayReconnects).toEqual([{ url: relayUrl, authToken: relayAuthToken }]);
			expect(endpointCloseCalls).toBe(0);
			expect(await pairAndReadNodeId()).toBe(nodeIdBeforeLoss);
			const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
				settings: { relayAuthToken?: string };
			};
			expect(state.settings.relayAuthToken).toBe(relayAuthToken);
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(relayReconnects).toHaveLength(1);
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
			expect(watchStopped).toBe(true);
		} finally {
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("iroh daemon lifecycle ownership", () => {
	it("closes admission synchronously and drains exactly the pre-close operation set", async () => {
		const gate = new IrohDaemonAdmissionGate();
		const first = gate.tryAcquire();
		const second = gate.tryAcquire();
		expect(first).toBeDefined();
		expect(second).toBeDefined();

		gate.close();
		expect(gate.isOpen).toBe(false);
		expect(first?.signal.aborted).toBe(true);
		expect(second?.signal.aborted).toBe(true);
		expect(first?.isCurrent()).toBe(false);
		expect(second?.isCurrent()).toBe(false);
		expect(gate.tryAcquire()).toBeUndefined();

		let drained = false;
		const draining = gate.waitForDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		first?.release();
		await Promise.resolve();
		expect(drained).toBe(false);
		second?.release();
		await draining;
		expect(drained).toBe(true);
	});

	it("uses one idempotent physical stream close action from lifecycle install through outer finalization", async () => {
		const fallbackReasons: string[] = [];
		const lifecycleReasons: string[] = [];
		let reentrantClose: Promise<void> | undefined;
		const owner = new IrohPhysicalStreamOwner((reason) => {
			fallbackReasons.push(reason);
		});
		let settled = false;
		void owner.settled.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(
			owner.installCloseAction((reason) => {
				lifecycleReasons.push(reason);
				reentrantClose = owner.close("reentrant_close");
			}),
		).toBe(true);

		const shutdown = owner.close("host_shutdown");
		const outerFinally = owner.close("stream_task_settled");
		expect(owner.settled).toBe(shutdown);
		expect(outerFinally).toBe(shutdown);
		expect(reentrantClose).toBe(shutdown);
		await outerFinally;

		expect(owner.isClosing).toBe(true);
		expect(settled).toBe(true);
		expect(lifecycleReasons).toEqual(["host_shutdown"]);
		expect(fallbackReasons).toEqual([]);
		expect(owner.installCloseAction(() => {})).toBe(false);
	});

	it("falls back to immediate physical close when shutdown wins before lifecycle install", async () => {
		const reasons: string[] = [];
		const owner = new IrohPhysicalStreamOwner((reason) => {
			reasons.push(reason);
		});

		await owner.close("host_shutdown");

		expect(reasons).toEqual(["host_shutdown"]);
		expect(owner.installCloseAction(() => {})).toBe(false);
	});

	it("fences application I/O without suppressing the owner's raw terminal operations", async () => {
		const readGate = createDeferred();
		const writeGate = createDeferred();
		let readCalls = 0;
		let writeCalls = 0;
		let resetCalls = 0;
		let stopCalls = 0;
		const rawStream: IrohBiStreamLike = {
			recv: {
				read: () => {
					readCalls++;
					return readGate.promise.then(() => undefined);
				},
				stop: () => {
					stopCalls++;
					return Promise.resolve();
				},
			},
			send: {
				writeAll: () => {
					writeCalls++;
					return writeGate.promise;
				},
				reset: () => {
					resetCalls++;
					return Promise.resolve();
				},
			},
		};
		const observed: Promise<unknown>[] = [];
		let terminalStream: IrohBiStreamLike | undefined;
		const owner = new IrohPhysicalStreamOwner(() => {
			void Promise.resolve(terminalStream?.send.reset?.(0n)).catch(() => {});
			void Promise.resolve(terminalStream?.recv.stop?.(0n)).catch(() => {});
		});
		const stream = createLifecycleFencedIrohStream(rawStream, owner.signal, (task) => observed.push(task));
		terminalStream = stream;

		const read = stream.recv.read(1);
		const write = stream.send.writeAll([1]);
		await owner.close("host_shutdown");

		await expect(read).rejects.toBeInstanceOf(IrohStreamLifecycleClosedError);
		await expect(write).rejects.toBeInstanceOf(IrohStreamLifecycleClosedError);
		expect({ readCalls, writeCalls, resetCalls, stopCalls }).toEqual({
			readCalls: 1,
			writeCalls: 1,
			resetCalls: 1,
			stopCalls: 1,
		});
		await expect(stream.recv.read(1)).rejects.toBeInstanceOf(IrohStreamLifecycleClosedError);
		await expect(stream.send.writeAll([2])).rejects.toBeInstanceOf(IrohStreamLifecycleClosedError);
		expect({ readCalls, writeCalls }).toEqual({ readCalls: 1, writeCalls: 1 });
		expect(observed).toHaveLength(4);

		readGate.resolve();
		writeGate.resolve();
		await Promise.allSettled(observed);
	});

	it("holds replacement close behind subscriber detach, zero-count publication, and active-stream removal", async () => {
		const events: string[] = [];
		let releaseLifecycle = () => {};
		const lifecycleSettled = new Promise<void>((resolve) => {
			releaseLifecycle = resolve;
		});
		const owner = new IrohPhysicalStreamOwner(() => {
			throw new Error("fallback close must not own an installed stream lifecycle");
		});
		expect(
			owner.installCloseAction(async (reason) => {
				events.push(`close_requested:${reason}`);
				await lifecycleSettled;
				events.push("physical_close_settled");
			}),
		).toBe(true);

		let replacementMayAttach = false;
		const replacementBarrier = owner.close("active_stream_replaced").then(() => {
			replacementMayAttach = true;
			events.push("replacement_attach_released");
		});
		await Promise.resolve();
		expect(replacementMayAttach).toBe(false);

		// This is the outer conversation-stream finally order. The old physical
		// owner cannot release the replacement barrier until the runtime subscriber
		// and capability-scoped lease count no longer include the old stream, and the
		// registry entry is synchronously removed.
		events.push("subscriber_detached");
		events.push("lease_count_zero");
		events.push("active_stream_removed");
		releaseLifecycle();
		await replacementBarrier;

		expect(events).toEqual([
			"close_requested:active_stream_replaced",
			"subscriber_detached",
			"lease_count_zero",
			"active_stream_removed",
			"physical_close_settled",
			"replacement_attach_released",
		]);
	});
});

describe.skipIf(!nativeAvailable)("TUI rekey alias relay admission (#259)", () => {
	it("reconnects an explicit old session alias through the canonical TUI lease", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-rekey-alias-"));
		const unresolvedWorkspaceDir = join(agentDir, "ws");
		mkdirSync(unresolvedWorkspaceDir, { recursive: true });
		const workspaceDir = realpathSync(unresolvedWorkspaceDir);
		const sourceSessionId = randomUUID();
		const replacementSessionId = randomUUID();
		const sessionDir = getDefaultSessionDir(workspaceDir, agentDir);
		const sourceSession = SessionManager.create(workspaceDir, sessionDir, { id: sourceSessionId });
		const replacementSession = SessionManager.create(workspaceDir, sessionDir, { id: replacementSessionId });
		await Promise.all([sourceSession.materialize(), replacementSession.materialize()]);

		const faux = registerFauxProvider();
		const model = faux.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[model.provider]: {
							api: model.api,
							apiKey: "faux-key",
							baseUrl: model.baseUrl,
							models: [{ id: model.id }],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }, null, 2)}\n`,
		);

		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let tui: DaemonClient | undefined;
		let phone: PhoneEndpoint | undefined;
		const phoneConnections: PhoneConnection[] = [];
		const relaySockets: Array<{ destroy(): void }> = [];
		const controlEvents: ControlEvent[] = [];
		const tuiEvents: ControlEvent[] = [];
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService({ relayMode: "disabled" }),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
				onEvent: (event) => controlEvents.push(event),
			});
			expect(await control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).toMatchObject({
				type: "ok",
			});

			const pairStarted = await control.request({ type: "pair_request", workspaceName: "ws" });
			expect(pairStarted).toMatchObject({ type: "pair_started" });
			let ticket: string | undefined;
			await expect
				.poll(() => {
					const event = controlEvents.find(
						(candidate) => candidate.type === "pairing_progress" && candidate.phase === "ticket",
					);
					ticket = event?.type === "pairing_progress" ? event.ticket : undefined;
					return ticket;
				})
				.toBeTypeOf("string");
			const payload = decodeIrohRemoteTicketPayload(ticket as string);
			const iroh = native.iroh;
			if (!iroh) throw new Error("native iroh unavailable");
			const endpointTicket = (
				iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
			).fromString(payload.irohTicket);
			phone = await createPhoneEndpoint();
			const pairingConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			phoneConnections.push(pairingConnection);
			const pairingStream = await pairingConnection.openBi();
			await writeJsonLine(pairingStream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				secret: payload.secret,
				clientLabel: "vitest-rekey-phone",
				workspaceDiscovery: { purpose: "list_sessions" },
			});
			expect((await readJsonLine(pairingStream)).value.success).toBe(true);
			pairingConnection.close(0n, Array.from(Buffer.from("done", "utf8")));
			await pairingConnection.closed();

			const clients = await control.request({ type: "clients_list" });
			expect(clients.type).toBe("clients_result");
			if (clients.type !== "clients_result" || !clients.clients[0]) {
				throw new Error("paired client missing");
			}
			const pairedClient = clients.clients[0];
			tui = createDaemonClient({
				socketPath: status.socketPath,
				client: "tui",
				version: "test",
				authToken: status.authToken,
				capabilities: [CONTROL_RPC_GRANTS_CAPABILITY],
				reconnect: false,
				onEvent: (event) => tuiEvents.push(event),
			});
			expect(
				await tui.request({ type: "lease_acquire", workspaceName: "ws", sessionId: sourceSessionId }),
			).toMatchObject({ type: "lease_granted" });

			const initialConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			phoneConnections.push(initialConnection);
			const initialStream = await initialConnection.openBi();
			await writeJsonLine(initialStream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				conversation: { target: "session", sessionId: sourceSessionId },
			});
			const initialResponse = readJsonLine(initialStream).then((response) => {
				throw new Error(`initial relay failed before offer: ${JSON.stringify(response.value)}`);
			});
			await Promise.race([
				expect
					.poll(() => tuiEvents.filter((event) => event.type === "relay_offer").length, { timeout: 5_000 })
					.toBe(1),
				initialResponse,
			]);
			const initialOffer = tuiEvents.find((event) => event.type === "relay_offer");
			if (initialOffer?.type !== "relay_offer") throw new Error("initial relay offer missing");
			const initialRelay = await tui.openRelay(initialOffer);
			relaySockets.push(initialRelay.stream);
			expect(initialRelay.preamble.resolvedTarget).toMatchObject({
				sessionId: sourceSessionId,
				selection: "resumed",
			});

			const prepared = await tui.request({
				type: "lease_rekey_prepare",
				workspaceName: "ws",
				oldSessionId: sourceSessionId,
				newSessionId: replacementSessionId,
			});
			expect(prepared.type).toBe("lease_rekey_prepared");
			if (prepared.type !== "lease_rekey_prepared") throw new Error("TUI rekey was not prepared");
			expect(await tui.request({ type: "lease_rekey_commit", transactionId: prepared.transactionId })).toMatchObject(
				{
					type: "ok",
				},
			);
			await expect
				.poll(() =>
					tuiEvents.some((event) => event.type === "relay_closed" && event.reason === "session_rekeyed_reconnect"),
				)
				.toBe(true);

			const aliasConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			phoneConnections.push(aliasConnection);
			const aliasStream = await aliasConnection.openBi();
			await writeJsonLine(aliasStream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				conversation: { target: "session", sessionId: sourceSessionId },
			});
			await expect
				.poll(() => tuiEvents.filter((event) => event.type === "relay_offer").length, { timeout: 5_000 })
				.toBe(2);
			const aliasOffer = tuiEvents.filter((event) => event.type === "relay_offer")[1];
			if (aliasOffer?.type !== "relay_offer") throw new Error("alias relay offer missing");
			expect(aliasOffer.sessionId).toBe(replacementSessionId);
			const aliasRelay = await tui.openRelay(aliasOffer);
			relaySockets.push(aliasRelay.stream);
			expect(aliasRelay.preamble.resolvedTarget).toMatchObject({
				sessionId: replacementSessionId,
				selection: "session_rekeyed",
				requestedSessionId: sourceSessionId,
			});
			expect(aliasRelay.preamble.handshake).toMatchObject({
				hello: { conversation: { target: "session", sessionId: sourceSessionId } },
			});

			const relayHandshake = aliasRelay.preamble.handshake as {
				hello: IrohRemoteHello;
				response: IrohRemoteHandshakeSuccess;
			};
			const authorizationSubset = aliasRelay.preamble.authorization;
			const authorization = {
				ok: true as const,
				allowTools: authorizationSubset.allowedTools,
				client: {
					nodeId: pairedClient.clientNodeId,
					label: pairedClient.label ?? pairedClient.clientNodeId,
					allowedWorkspaces: ["ws"],
					allowedTools: authorizationSubset.allowedTools,
					rpcGrant: authorizationSubset.rpcGrant,
					pairedAt: pairedClient.pairedAtMs,
					lastSeenAt: pairedClient.lastSeenAtMs ?? pairedClient.pairedAtMs,
				},
				paired: true,
				pairingSecretConsumed: false,
				workspace: { name: "ws", path: workspaceDir },
				workspaceNames: ["ws"],
				workspaces: [{ name: "ws", status: "available" as const }],
			} satisfies IrohRemoteClientAuthorizationSuccess;
			const handshakeResponse = createIntegratedConversationHandshakeResponse(
				relayHandshake,
				authorization,
				replacementSessionId,
				{ kind: "session_rekeyed", requestedSessionId: sourceSessionId, sessionId: replacementSessionId },
				{
					hostNodeId: aliasRelay.preamble.hostNodeId,
					relayMode: aliasRelay.preamble.relayMode,
					relayUrls: aliasRelay.preamble.relayUrls,
				},
			);
			aliasRelay.stream.write(`${JSON.stringify(handshakeResponse)}\n`);
			const phoneHandshake = parseIrohRemoteHandshakeResponse((await readJsonLine(aliasStream)).value);
			expect(phoneHandshake).toMatchObject({
				success: true,
				sessionId: replacementSessionId,
				conversation: {
					target: "session",
					sessionId: replacementSessionId,
					selection: "session_rekeyed",
					requestedSessionId: sourceSessionId,
				},
			});

			const directConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			phoneConnections.push(directConnection);
			const directStream = await directConnection.openBi();
			await writeJsonLine(directStream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				conversation: { target: "session", sessionId: replacementSessionId },
			});
			await expect
				.poll(() => tuiEvents.filter((event) => event.type === "relay_offer").length, { timeout: 5_000 })
				.toBe(3);
			const directOffer = tuiEvents.filter((event) => event.type === "relay_offer")[2];
			if (directOffer?.type !== "relay_offer") throw new Error("canonical relay offer missing");
			expect(directOffer.sessionId).toBe(replacementSessionId);
			const directRelay = await tui.openRelay(directOffer);
			relaySockets.push(directRelay.stream);
			expect(directRelay.preamble.resolvedTarget).toMatchObject({
				sessionId: replacementSessionId,
				selection: "resumed",
				requestedSessionId: replacementSessionId,
			});

			const currentStatus = await control.request({ type: "status" });
			expect(currentStatus).toMatchObject({
				type: "status_result",
				leases: [
					{
						workspaceName: "ws",
						sessionId: replacementSessionId,
						state: "tui-owned",
					},
				],
			});
			expect(readFileSync(getDaemonPaths(agentDir).auditPath, "utf8")).not.toContain('"type":"runtime_failure"');
		} finally {
			for (const socket of relaySockets) socket.destroy();
			for (const connection of phoneConnections) {
				connection.close(0n, Array.from(Buffer.from("done", "utf8")));
			}
			await phone?.close().catch(() => {});
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
				daemonStopped = true;
			}
			await tui?.close();
			await control?.close();
			faux.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh service (loopback)", () => {
	let agentDir: string;
	let workspaceDir: string;
	let daemon: Promise<number>;
	let daemonStopped = false;
	let control: DaemonClient;
	const controlEvents: ControlEvent[] = [];

	beforeAll(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-"));
		workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService({ relayMode: "disabled" }, { decorateEndpoint: withStalledClose }),
		]);
		let status: DaemonProbeResult = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => controlEvents.push(event),
		});
		const registered = await control.request({ type: "workspace_register", name: "ws", path: workspaceDir });
		expect(registered.type).toBe("ok");
	}, 30_000);

	afterAll(async () => {
		if (!daemonStopped) {
			try {
				await control.request({ type: "shutdown" });
			} catch {
				// daemon may already be gone
			}
		}
		await control?.close();
		await daemon;
		rmSync(agentDir, { recursive: true, force: true });
	}, 30_000);

	it("pairs a phone, serves workspace discovery, and revokes", async () => {
		// Pair over the control plane.
		const pairResponse = await control.request({ type: "pair_request", workspaceName: "ws" });
		expect(pairResponse.type).toBe("pair_started");
		let ticketEvent: (ControlEvent & { type: "pairing_progress" }) | undefined;
		await expect
			.poll(
				() => {
					ticketEvent = controlEvents.find(
						(event): event is ControlEvent & { type: "pairing_progress" } =>
							event.type === "pairing_progress" && event.phase === "ticket",
					);
					return ticketEvent !== undefined;
				},
				{ timeout: 15_000 },
			)
			.toBe(true);
		const ticket = ticketEvent?.ticket;
		expect(ticket).toBeDefined();
		const payload = decodeIrohRemoteTicketPayload(ticket as string);
		expect(payload.workspace).toBe("ws");
		expect(payload.secret).toBeDefined();

		// Phone connects with the pairing secret and opens a workspaceDiscovery stream.
		const iroh = native.iroh;
		if (!iroh) {
			throw new Error("native iroh unavailable");
		}
		const phone = await createPhoneEndpoint();
		const endpointTicket = (
			iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
		).fromString(payload.irohTicket);
		const connection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		expect(connection.remoteId().toString()).toBe(payload.nodeId);
		const stream = await connection.openBi();
		await writeJsonLine(stream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			secret: payload.secret,
			clientLabel: "vitest-phone",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const handshake = await readJsonLine(stream);
		expect(handshake.value.type).toBe("volt_iroh_handshake");
		expect(handshake.value.success).toBe(true);
		expect(handshake.value.workspace).toBe("ws");

		// Pairing completion is pushed to the control client.
		await expect
			.poll(() => controlEvents.some((event) => event.type === "pairing_progress" && event.phase === "completed"), {
				timeout: 10_000,
			})
			.toBe(true);

		// list_sessions works over the discovery stream.
		await writeJsonLine(stream, { id: "ls-1", type: "list_sessions" });
		const listResponse = await readJsonLine(stream, handshake.rest);
		expect(listResponse.value.command).toBe("list_sessions");
		expect(listResponse.value.success).toBe(true);
		expect((listResponse.value.data as Record<string, unknown>).sessions).toEqual([]);
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await connection.closed();

		// The client is paired and reconnects WITHOUT the secret.
		const clients = await control.request({ type: "clients_list" });
		expect(clients.type).toBe("clients_result");
		if (clients.type === "clients_result") {
			expect(clients.clients).toHaveLength(1);
		}
		const pairedClientNodeId = clients.type === "clients_result" ? (clients.clients[0]?.clientNodeId as string) : "";

		// relay_rpc is bound to a live relay and its owning TUI control connection;
		// a regular control client cannot forge that authority.
		const missingRelay = await control.request({
			type: "relay_rpc",
			relayId: "rl-missing",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: { type: "register_push_target", id: "rp-1", args: {} },
		});
		expect(missingRelay).toMatchObject({ type: "error", code: "not_found", message: "active relay not found" });

		const reconnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		const reconnectStream = await reconnection.openBi();
		await writeJsonLine(reconnectStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const reconnectHandshake = await readJsonLine(reconnectStream);
		expect(reconnectHandshake.value.success).toBe(true);
		await writeJsonLine(reconnectStream, { id: "ls-reconnect-1", type: "list_sessions" });
		const reconnectListResponse = await readJsonLine(reconnectStream, reconnectHandshake.rest);
		expect(reconnectListResponse.value.command).toBe("list_sessions");
		expect(reconnectListResponse.value.success).toBe(true);

		// Completing one stream must leave the multi-stream connection reusable.
		await reconnectStream.send.finish();
		expect(await reconnectStream.send.stopped()).toBeNull();
		await reconnectStream.recv.stop?.(0n);
		const reusedStream = await reconnection.openBi();
		await writeJsonLine(reusedStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const reusedHandshake = await readJsonLine(reusedStream);
		expect(reusedHandshake.value.success).toBe(true);
		await writeJsonLine(reusedStream, { id: "ls-reconnect-2", type: "list_sessions" });
		const reusedListResponse = await readJsonLine(reusedStream, reusedHandshake.rest);
		expect(reusedListResponse.value.command).toBe("list_sessions");
		expect(reusedListResponse.value.success).toBe(true);
		reconnection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await reconnection.closed();

		// Revocation closes the door: the next handshake is rejected.
		const clientNodeId = clients.type === "clients_result" ? clients.clients[0]?.clientNodeId : undefined;
		expect(clientNodeId).toBeDefined();
		const revoked = await control.request({ type: "client_revoke", clientNodeId: clientNodeId as string });
		expect(revoked.type).toBe("ok");
		const revokedConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		const revokedStream = await revokedConnection.openBi();
		await writeJsonLine(revokedStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const revokedHandshake = await readJsonLine(revokedStream);
		expect(revokedHandshake.value.success).toBe(false);
		expect(revokedHandshake.value.outcome).toBe("client_revoked");
		const revokedStreamEnd = await readLineFromIroh(revokedStream.recv, revokedHandshake.rest, {
			maxLineBytes: 1024 * 1024,
		});
		expect(revokedStreamEnd.line).toBeUndefined();
		expect(revokedStreamEnd.rest).toHaveLength(0);

		// A terminal handshake failure closes only its stream. Once the host FIN is
		// observed, another stream on the same connection must still receive the
		// structured failure instead of losing it to a parent-connection close.
		const retriedRevokedStream = await revokedConnection.openBi();
		await writeJsonLine(retriedRevokedStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const retriedRevokedHandshake = await readJsonLine(retriedRevokedStream);
		expect(retriedRevokedHandshake.value.success).toBe(false);
		expect(retriedRevokedHandshake.value.outcome).toBe("client_revoked");
		const retriedRevokedStreamEnd = await readLineFromIroh(retriedRevokedStream.recv, retriedRevokedHandshake.rest, {
			maxLineBytes: 1024 * 1024,
		});
		expect(retriedRevokedStreamEnd.line).toBeUndefined();
		expect(retriedRevokedStreamEnd.rest).toHaveLength(0);

		// Leave a live connection with an admitted handshake child at daemon
		// shutdown. Quiesce must settle that application child before core state
		// closes; endpoint/connection native settlement remains disposal work.
		await revokedConnection.openBi();
		await expect
			.poll(async () => {
				const status = await control.request({ type: "status" });
				return status.type === "status_result" ? status.phoneConnections : 0;
			})
			.toBeGreaterThan(0);
		await control.request({ type: "shutdown" });
		await daemon;
		daemonStopped = true;
		const paths = getDaemonPaths(agentDir);
		expect(existsSync(paths.pidfilePath)).toBe(false);
		expect(existsSync(paths.socketPath)).toBe(false);
		expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
		await revokedConnection.closed();
		await phone.close();
	}, 60_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh live workspace unregister", () => {
	it("delivers the response before retiring conversation authority and runtime ownership", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-live-unregister-"));
		const workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		const faux = registerFauxProvider();
		const model = faux.getModel();
		writeFileSync(
			join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[model.provider]: {
							api: model.api,
							apiKey: "faux-key",
							baseUrl: model.baseUrl,
							models: [{ id: model.id }],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }, null, 2)}\n`,
		);
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let phone: PhoneEndpoint | undefined;
		let connection: PhoneConnection | undefined;
		let pauseRacingPublications = false;
		let conversationPublicationStarted = false;
		let utilityPublicationStarted = false;
		const conversationPublicationGate = createDeferred();
		const utilityPublicationGate = createDeferred();
		const unregisterResponseWriteGate = createDeferred();
		let unregisterResponseWriteStarted = false;
		const controlEvents: ControlEvent[] = [];
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{
					beforeAuthorizedStreamPublication: async (kind) => {
						if (!pauseRacingPublications) return;
						if (kind === "conversation") {
							conversationPublicationStarted = true;
							await conversationPublicationGate.promise;
						} else if (kind === "workspace_discovery") {
							utilityPublicationStarted = true;
							await utilityPublicationGate.promise;
						}
					},
					decorateAcceptedStream: (stream) =>
						withGatedUnregisterResponse(
							stream,
							() => {
								unregisterResponseWriteStarted = true;
							},
							unregisterResponseWriteGate.promise,
						),
				},
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
				onEvent: (event) => controlEvents.push(event),
			});
			expect(await control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).toMatchObject({
				type: "ok",
			});
			const pairStarted = await control.request({ type: "pair_request", workspaceName: "ws", access: "full" });
			expect(pairStarted).toMatchObject({ type: "pair_started" });
			if (pairStarted.type !== "pair_started") throw new Error("pair request did not start");
			let ticket: string | undefined;
			await expect
				.poll(() => {
					const event = controlEvents.find(
						(candidate) => candidate.type === "pairing_progress" && candidate.phase === "ticket",
					);
					ticket = event?.type === "pairing_progress" ? event.ticket : undefined;
					return ticket;
				})
				.toBeTypeOf("string");
			const payload = decodeIrohRemoteTicketPayload(ticket as string);
			const iroh = native.iroh;
			if (!iroh) throw new Error("native iroh unavailable");
			const endpointTicket = (
				iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
			).fromString(payload.irohTicket);
			phone = await createPhoneEndpoint();
			connection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			const stream = await connection.openBi();
			await writeJsonLine(stream, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				secret: payload.secret,
				clientLabel: "vitest-live-unregister",
				conversation: { target: "new", sessionId: "live-unregister-session" },
			});
			const handshake = await readJsonLine(stream);
			expect(handshake.value).toMatchObject({ type: "volt_iroh_handshake", success: true, workspace: "ws" });
			const bootstrap = await readJsonLine(stream, handshake.rest);
			expect(bootstrap.value.type).toBe("conversation_bootstrap");
			const conversation = bootstrap.value.conversation as { sessionId: string };
			const delivery = bootstrap.value.delivery as { subscriptionId: string };
			const transcript = bootstrap.value.transcript as { branchEpoch: string };

			pauseRacingPublications = true;
			const racingConversation = await connection.openBi();
			await writeJsonLine(racingConversation, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				clientLabel: "vitest-racing-conversation",
				conversation: { target: "new", sessionId: "racing-conversation-session" },
			});
			await expect.poll(() => conversationPublicationStarted).toBe(true);

			const racingUtility = await connection.openBi();
			await writeJsonLine(racingUtility, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				clientLabel: "vitest-racing-utility",
				workspaceDiscovery: { purpose: "list_sessions" },
			});
			await writeJsonLine(racingUtility, { id: "stale-list", type: "list_sessions" });
			await expect.poll(() => utilityPublicationStarted).toBe(true);
			const racingUtilityHandshake = await readJsonLine(racingUtility);
			expect(racingUtilityHandshake.value).toMatchObject({
				type: "volt_iroh_handshake",
				success: true,
				workspace: "ws",
			});

			await writeJsonLine(stream, {
				id: "remove-live",
				type: "unregister_workspace",
				workspaceName: "ws",
				conversationAuthority: {
					sessionId: conversation.sessionId,
					subscriptionId: delivery.subscriptionId,
					branchEpoch: transcript.branchEpoch,
				},
			});
			await expect.poll(() => unregisterResponseWriteStarted).toBe(true);
			await writeJsonLine(stream, { id: "pipelined", type: "get_state" });
			unregisterResponseWriteGate.resolve();
			const unregisterResponse = await readJsonLineMatching(
				stream,
				bootstrap.rest,
				(value) => value.type === "response" && value.command === "unregister_workspace",
			);
			expect(unregisterResponse.value).toMatchObject({
				id: "remove-live",
				type: "response",
				command: "unregister_workspace",
				success: true,
				data: { removedWorkspace: "ws", workspaceNames: [], workspaces: [] },
			});
			let terminal: Awaited<ReturnType<typeof readJsonLine>> | undefined;
			try {
				terminal = await readJsonLine(stream, unregisterResponse.rest);
			} catch {
				// The explicit terminal is best-effort once the response is delivered;
				// native Iroh may expose the ensuing transport retirement as Reset(0).
			}
			if (terminal) {
				expect(terminal.value).toMatchObject({
					type: "remote_terminal",
					reason: "workspace_unregistered",
					workspace: "ws",
					sessionId: conversation.sessionId,
				});
			}

			await expect(
				control.request({ type: "workspace_register", name: "ws", path: workspaceDir }),
			).resolves.toMatchObject({ type: "ok" });
			pauseRacingPublications = false;
			const freshUtility = await connection.openBi();
			await writeJsonLine(freshUtility, {
				type: "volt_iroh_hello",
				protocol: IROH_REMOTE_ALPN,
				workspace: "ws",
				clientLabel: "vitest-fresh-utility",
				workspaceDiscovery: { purpose: "list_sessions" },
			});
			const freshUtilityHandshake = await readJsonLine(freshUtility);
			expect(freshUtilityHandshake.value).toMatchObject({
				type: "volt_iroh_handshake",
				success: true,
				workspace: "ws",
			});
			await writeJsonLine(freshUtility, { id: "fresh-list", type: "list_sessions" });
			const freshListResponse = await readJsonLine(freshUtility, freshUtilityHandshake.rest);
			expect(freshListResponse.value).toMatchObject({
				id: "fresh-list",
				type: "response",
				command: "list_sessions",
				success: true,
			});

			conversationPublicationGate.resolve();
			utilityPublicationGate.resolve();
			let racingConversationFailure: Record<string, unknown> | undefined;
			try {
				racingConversationFailure = (await readJsonLine(racingConversation)).value;
			} catch {
				// A reset before any success handshake is also a valid stale-attach rejection.
			}
			expect(racingConversationFailure?.success).not.toBe(true);
			let racingUtilityTail: string | undefined;
			try {
				racingUtilityTail = (
					await readLineFromIroh(racingUtility.recv, racingUtilityHandshake.rest, { maxLineBytes: 1024 * 1024 })
				).line;
			} catch {
				// A native reset also proves the queued utility command was not served.
			}
			expect(racingUtilityTail).toBeUndefined();

			await expect
				.poll(async () => {
					const current = await control?.request({ type: "status" });
					return current?.type === "status_result" ? current.leases : undefined;
				})
				.toEqual([]);
			await expect(control.request({ type: "workspace_unregister", name: "ws" })).resolves.toMatchObject({
				type: "ok",
			});
			await expect
				.poll(() => readFileSync(getDaemonPaths(agentDir).auditPath, "utf8"))
				.toContain('"reason":"workspace_unregistered"');
			let postUnregisterLine: string | undefined;
			try {
				postUnregisterLine = (
					await readLineFromIroh(stream.recv, terminal?.rest ?? unregisterResponse.rest, {
						maxLineBytes: 1024 * 1024,
					})
				).line;
			} catch {
				// A native reset is also a valid terminal observation.
			}
			expect(postUnregisterLine).toBeUndefined();
		} finally {
			conversationPublicationGate.resolve();
			utilityPublicationGate.resolve();
			unregisterResponseWriteGate.resolve();
			connection?.close(0n, Array.from(Buffer.from("done", "utf8")));
			await phone?.close().catch(() => {});
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
				daemonStopped = true;
			}
			await control?.close();
			faux.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd managed relay credential startup", () => {
	it("rejects an old canary persisted credential authority before network use", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-old-canary-credential-"));
		const credential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		persistCanaryManagedRelayAuthority(
			agentDir,
			credential,
			"credential",
			VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
		try {
			const result = await captureIrohStartupError(agentDir);
			expect(result.error).toBe(
				`managed relay credential authority service URL ${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL} conflicts with the built-in relay deployment broker ${VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL}`,
			);
			expect(result.endpointDecorations).toBe(0);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects an old canary pending claim authority before network use", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-old-canary-claim-"));
		const credential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		persistCanaryManagedRelayAuthority(agentDir, credential, "claim", VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
		try {
			const result = await captureIrohStartupError(agentDir);
			expect(result.error).toBe(
				`managed relay claim authority service URL ${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL} conflicts with the built-in relay deployment broker ${VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL}`,
			);
			expect(result.endpointDecorations).toBe(0);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects old canary revocation state under an explicit production relay override before network use", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-old-canary-revocation-"));
		const credential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		persistCanaryManagedRelayAuthority(
			agentDir,
			credential,
			"revocation",
			VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
		try {
			const result = await captureIrohStartupError(agentDir, {
				relayMode: "production",
				relayUrls: [...VOLT_PRODUCTION_RELAY_URLS],
				relayCredentialServiceUrl: VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
			});
			expect(result.error).toBe("managed relay credential revocation is scoped to a different relay origin set");
			expect(result.endpointDecorations).toBe(0);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("accepts a persisted canary credential scoped to the new canary broker", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-new-canary-credential-"));
		const credential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		persistCanaryManagedRelayAuthority(agentDir, credential, "credential", VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
		const relayInsertions: IrohRelayConfigLike[] = [];
		let endpointDecorations = 0;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) => {
						endpointDecorations++;
						return withRecordedRelayCredentialInstall(endpoint, relayInsertions, () => {});
					},
				},
			),
		]);
		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			expect(endpointDecorations).toBe(1);
			expect(relayInsertions).toEqual([]);
			const persistedState = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
				settings: { relayCredential?: IrohManagedRelayCredential };
			};
			expect(persistedState.settings.relayCredential).toMatchObject({
				serviceUrl: VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
				relayUrls: VOLT_CANARY_RELAY_URLS,
				accessToken: credential.accessToken,
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
		} finally {
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps host revocation authoritative over an admitted claim installer and restart", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-revoke-race-"));
		const restartAgentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-revoke-restart-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		const exchangedAccessToken = "exchanged.payload.signature";
		const claimId = "claimabcdefghijklmnopqrs";
		const appEndpointId = "appendpointabcdefghijklm";
		const appNodeId = "b".repeat(64);
		const reconnectGate = createDeferred();
		const brokerRevokeGate = createDeferred();
		const relayReconnects: IrohRelayConfigLike[] = [];
		const relayRemovals: string[] = [];
		const restartRelayReconnects: IrohRelayConfigLike[] = [];
		let reconnectStarted = false;
		let relayWatchStarted = false;
		let relayWatchStopped = false;
		let brokerRevokeRequests = 0;
		let daemonStopped = false;
		let restartDaemonStopped = false;
		let control: DaemonClient | undefined;
		let restartControl: DaemonClient | undefined;
		let restartDaemon: Promise<number> | undefined;
		let revocationRequest: ReturnType<DaemonClient["request"]> | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims`) {
				return new Response(
					JSON.stringify({ claimId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims/${claimId}/exchange`) {
				return new Response(
					JSON.stringify({
						grantId: originalCredential.grantId,
						endpointId: originalCredential.endpointId,
						hostNodeId: originalCredential.endpointNodeId,
						appEndpointId,
						appNodeId,
						credential: {
							accessToken: exchangedAccessToken,
							accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
							tokenType: "Bearer",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/grant/revoke`) {
				brokerRevokeRequests++;
				await brokerRevokeGate.promise;
				return new Response(null, { status: 204 });
			}
			throw new Error(`unexpected managed relay credential request: ${url}`);
		});
		let relayWatcher: IrohHomeRelayWatchCallback | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					relayWatchApiSafe: true,
					relayReconnectApiSafe: true,
					decorateEndpoint: (endpoint) => ({
						id: () => endpoint.id(),
						addr: () => endpoint.addr(),
						online: () => Promise.resolve(),
						async reconnectRelay(config) {
							relayReconnects.push(config);
							reconnectStarted = true;
							await reconnectGate.promise;
							relayWatcher?.(null, [config.url]);
						},
						async removeRelay(url) {
							relayRemovals.push(url);
							return true;
						},
						watchHomeRelay: (callback) => {
							relayWatchStarted = true;
							relayWatcher = callback;
							return {
								async stop() {
									relayWatcher = undefined;
									relayWatchStopped = true;
								},
							};
						},
						acceptNext: () => endpoint.acceptNext(),
						secretKey: () => endpoint.secretKey(),
						close: () => endpoint.close(),
					}),
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			expect(relayWatchStarted).toBe(true);
			expect(await control.request({ type: "pair_request" })).toMatchObject({ type: "pair_started" });
			await expect.poll(() => reconnectStarted, { timeout: 5_000 }).toBe(true);

			revocationRequest = control.request({ type: "relay_credential_revoke" });
			void revocationRequest.catch(() => {});
			await expect.poll(() => relayWatchStopped, { timeout: 5_000 }).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			reconnectGate.resolve();
			await expect.poll(() => brokerRevokeRequests, { timeout: 5_000 }).toBe(1);

			const statePath = getDaemonPaths(agentDir).statePath;
			const intermediateState = JSON.parse(readFileSync(statePath, "utf8")) as {
				settings: {
					relayAuthToken?: string;
					relayCredential?: IrohManagedRelayCredential;
					relayCredentialClaim?: unknown;
					relayCredentialRevocation?: IrohManagedRelayCredential;
				};
			};
			expect(intermediateState.settings.relayCredentialRevocation).toEqual(
				expect.objectContaining({
					...originalCredential,
					accessToken: exchangedAccessToken,
					accessTokenExpiresAt: expect.any(Number),
				}),
			);
			expect(intermediateState.settings.relayAuthToken).toBeUndefined();
			expect(intermediateState.settings.relayCredential).toBeUndefined();
			expect(intermediateState.settings.relayCredentialClaim).toBeUndefined();
			expect(relayReconnects).toEqual([{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: exchangedAccessToken }]);
			expect(relayRemovals).toContain(VOLT_PRODUCTION_RELAY_URLS[0]);

			const restartPaths = getDaemonPaths(restartAgentDir);
			mkdirSync(restartPaths.daemonDir, { recursive: true });
			writeFileSync(restartPaths.statePath, `${JSON.stringify(intermediateState, null, 2)}\n`);
			restartDaemon = runVoltDaemon({ agentDir: restartAgentDir, foreground: false }, [
				createIrohDaemonService(
					{},
					{
						decorateEndpoint: (endpoint) =>
							withRecordedRelayCredentialInstall(endpoint, restartRelayReconnects, () => {}),
					},
				),
			]);
			const restartStatus = await waitForHealthyDaemon(restartAgentDir);
			restartControl = createDaemonClient({
				socketPath: restartStatus.socketPath,
				client: "cli",
				version: "test",
				authToken: restartStatus.authToken,
				reconnect: false,
			});
			await expect.poll(() => brokerRevokeRequests, { timeout: 5_000 }).toBe(2);
			const restartIntermediateState = JSON.parse(readFileSync(restartPaths.statePath, "utf8")) as {
				settings: {
					relayAuthToken?: string;
					relayCredential?: IrohManagedRelayCredential;
					relayCredentialClaim?: unknown;
					relayCredentialRevocation?: IrohManagedRelayCredential;
				};
			};
			expect(restartIntermediateState.settings.relayCredentialRevocation).toEqual(
				expect.objectContaining({
					...originalCredential,
					accessToken: exchangedAccessToken,
					accessTokenExpiresAt: expect.any(Number),
				}),
			);
			expect(restartIntermediateState.settings.relayAuthToken).toBeUndefined();
			expect(restartIntermediateState.settings.relayCredential).toBeUndefined();
			expect(restartIntermediateState.settings.relayCredentialClaim).toBeUndefined();
			expect(restartRelayReconnects).toEqual([]);

			brokerRevokeGate.resolve();
			await expect(revocationRequest).resolves.toMatchObject({ type: "ok" });
			await expectIrohEndpointReady(restartControl);
			expect(restartRelayReconnects).toEqual([]);
			const finalState = JSON.parse(readFileSync(statePath, "utf8")) as {
				settings: Record<string, unknown>;
			};
			expect(finalState.settings.relayAuthToken).toBeUndefined();
			expect(finalState.settings.relayCredential).toBeUndefined();
			expect(finalState.settings.relayCredentialClaim).toBeUndefined();
			expect(finalState.settings.relayCredentialRevocation).toBeUndefined();

			expect((await restartControl.request({ type: "shutdown" })).type).toBe("ok");
			await restartDaemon;
			restartDaemonStopped = true;
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
		} finally {
			reconnectGate.resolve();
			brokerRevokeGate.resolve();
			await revocationRequest?.catch(() => {});
			if (!restartDaemonStopped && restartDaemon !== undefined) {
				await restartControl?.request({ type: "shutdown" }).catch(() => {});
				await restartDaemon;
			}
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await restartControl?.close();
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(restartAgentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps an exchanged claim retryable until live relay reconnect is confirmed", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-exchange-reconnect-retry-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		const claimId = "claimabcdefghijklmnopqrs";
		const exchangedAccessToken = "exchanged.payload.signature";
		const relayReconnects: IrohRelayConfigLike[] = [];
		let exchangeRequests = 0;
		let reconnectAttempts = 0;
		let credentialWasDurableBeforeReconnect = false;
		let claimWasDurableBeforeReconnect = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims`) {
				return new Response(
					JSON.stringify({ claimId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims/${claimId}/exchange`) {
				exchangeRequests++;
				return new Response(
					JSON.stringify({
						grantId: originalCredential.grantId,
						endpointId: originalCredential.endpointId,
						hostNodeId: originalCredential.endpointNodeId,
						appEndpointId: "appendpointabcdefghijklm",
						appNodeId: "b".repeat(64),
						credential: {
							accessToken: exchangedAccessToken,
							accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
							tokenType: "Bearer",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`unexpected managed relay credential request: ${url}`);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let pairingRequestId: string | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) =>
						withRecordedRelayCredentialInstall(
							endpoint,
							relayReconnects,
							() => {},
							undefined,
							undefined,
							() => {
								reconnectAttempts++;
								if (reconnectAttempts !== 1) return;
								const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
									settings: {
										relayCredential?: IrohManagedRelayCredential;
										relayCredentialClaim?: { claimId: string };
									};
								};
								credentialWasDurableBeforeReconnect =
									state.settings.relayCredential?.accessToken === exchangedAccessToken;
								claimWasDurableBeforeReconnect = state.settings.relayCredentialClaim?.claimId === claimId;
								throw new Error("injected first relay reconnect failure");
							},
						),
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			const pairing = await control.request({ type: "pair_request" });
			expect(pairing).toMatchObject({ type: "pair_started" });
			if (pairing.type !== "pair_started") throw new Error("managed relay pairing did not start");
			pairingRequestId = pairing.requestId;

			await expect.poll(() => reconnectAttempts, { timeout: 5_000 }).toBe(2);
			expect(exchangeRequests).toBe(2);
			expect(credentialWasDurableBeforeReconnect).toBe(true);
			expect(claimWasDurableBeforeReconnect).toBe(true);
			expect(relayReconnects).toEqual([{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: exchangedAccessToken }]);
			await expect
				.poll(() => {
					const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
						settings: {
							relayCredential?: IrohManagedRelayCredential;
							relayCredentialClaim?: unknown;
						};
					};
					return {
						accessToken: state.settings.relayCredential?.accessToken,
						claim: state.settings.relayCredentialClaim,
					};
				})
				.toEqual({ accessToken: exchangedAccessToken, claim: undefined });

			expect(await control.request({ type: "pair_cancel", requestId: pairing.requestId })).toMatchObject({
				type: "ok",
			});
			pairingRequestId = undefined;
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
		} finally {
			if (!daemonStopped) {
				if (pairingRequestId !== undefined) {
					await control?.request({ type: "pair_cancel", requestId: pairingRequestId }).catch(() => {});
				}
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("refreshes a committed credential when pairing cancellation supersedes its claim during reconnect", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-cancel-during-reconnect-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		const claimId = "claimabcdefghijklmnopqrs";
		const exchangedAccessToken = "exchanged.payload.signature";
		const refreshedAccessToken = "refreshed.payload.signature";
		const reconnectGate = createDeferred();
		const relayReconnects: IrohRelayConfigLike[] = [];
		let reconnectAttempts = 0;
		let reconnectStarted = false;
		let exchangeRequests = 0;
		let refreshRequests = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims`) {
				return new Response(
					JSON.stringify({ claimId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims/${claimId}/exchange`) {
				exchangeRequests++;
				return new Response(
					JSON.stringify({
						grantId: originalCredential.grantId,
						endpointId: originalCredential.endpointId,
						hostNodeId: originalCredential.endpointNodeId,
						appEndpointId: "appendpointabcdefghijklm",
						appNodeId: "b".repeat(64),
						credential: {
							accessToken: exchangedAccessToken,
							accessTokenExpiresAt: new Date(Date.now() + 31_000).toISOString(),
							tokenType: "Bearer",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/tokens/refresh`) {
				refreshRequests++;
				return new Response(
					JSON.stringify({
						accessToken: refreshedAccessToken,
						accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
						tokenType: "Bearer",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`unexpected managed relay credential request: ${url}`);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let pairingRequestId: string | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) =>
						withRecordedRelayCredentialInstall(
							endpoint,
							relayReconnects,
							() => {},
							undefined,
							undefined,
							async () => {
								reconnectAttempts++;
								if (reconnectAttempts !== 1) return;
								reconnectStarted = true;
								await reconnectGate.promise;
							},
						),
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			const pairing = await control.request({ type: "pair_request" });
			expect(pairing).toMatchObject({ type: "pair_started" });
			if (pairing.type !== "pair_started") throw new Error("managed relay pairing did not start");
			pairingRequestId = pairing.requestId;
			await expect.poll(() => reconnectStarted, { timeout: 5_000 }).toBe(true);

			expect(await control.request({ type: "pair_cancel", requestId: pairing.requestId })).toMatchObject({
				type: "ok",
			});
			pairingRequestId = undefined;
			const cancelledState = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
				settings: {
					relayCredential?: IrohManagedRelayCredential;
					relayCredentialClaim?: unknown;
				};
			};
			expect(cancelledState.settings.relayCredential?.accessToken).toBe(exchangedAccessToken);
			expect(cancelledState.settings.relayCredentialClaim).toBeUndefined();

			reconnectGate.resolve();
			await expect.poll(() => refreshRequests, { timeout: 5_000 }).toBe(1);
			expect(exchangeRequests).toBe(1);
			await expect
				.poll(() => relayReconnects, { timeout: 5_000 })
				.toEqual([
					{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: exchangedAccessToken },
					{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: refreshedAccessToken },
				]);
			const refreshedState = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
				settings: {
					relayCredential?: IrohManagedRelayCredential;
					relayCredentialClaim?: unknown;
				};
			};
			expect(refreshedState.settings.relayCredential?.accessToken).toBe(refreshedAccessToken);
			expect(refreshedState.settings.relayCredentialClaim).toBeUndefined();

			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
		} finally {
			reconnectGate.resolve();
			if (!daemonStopped) {
				if (pairingRequestId !== undefined) {
					await control?.request({ type: "pair_cancel", requestId: pairingRequestId }).catch(() => {});
				}
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("durably installs and confirms a live relay reconnect when refreshing a valid JWT", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-refresh-reconnect-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, 31_000);
		const refreshedAccessToken = "refreshed.payload.signature";
		const relayReconnects: IrohRelayConfigLike[] = [];
		const relayMutations: string[] = [];
		let credentialWasDurableBeforeReconnect = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/tokens/refresh`) {
				throw new Error(`unexpected managed relay credential request: ${url}`);
			}
			return new Response(
				JSON.stringify({
					accessToken: refreshedAccessToken,
					accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
					tokenType: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) =>
						withRecordedRelayCredentialInstall(
							endpoint,
							relayReconnects,
							() => {},
							undefined,
							relayMutations,
							() => {
								const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
									settings: { relayCredential?: IrohManagedRelayCredential };
								};
								credentialWasDurableBeforeReconnect =
									state.settings.relayCredential?.accessToken === refreshedAccessToken;
							},
						),
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			await expect
				.poll(() => relayReconnects, { timeout: 5_000 })
				.toEqual([{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: refreshedAccessToken }]);
			expect(Date.now()).toBeLessThan(originalCredential.accessTokenExpiresAt);
			expect(credentialWasDurableBeforeReconnect).toBe(true);
			expect(relayMutations).toEqual([`reconnect:${VOLT_PRODUCTION_RELAY_URLS[0]}`]);
			const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
				settings: { relayCredential?: IrohManagedRelayCredential };
			};
			expect(state.settings.relayCredential?.accessToken).toBe(refreshedAccessToken);
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await daemon;
			daemonStopped = true;
		} finally {
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("starts degraded with an expired JWT and installs a refreshed credential after broker recovery", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-startup-expired-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, -60_000);
		const refreshedAccessToken = "refreshed.payload.signature";
		const relayInsertions: IrohRelayConfigLike[] = [];
		let brokerAvailable = false;
		let refreshRequests = 0;
		let endpointDecorations = 0;
		let endpointCloseCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/tokens/refresh`) {
				throw new Error(`unexpected managed relay credential request: ${url}`);
			}
			refreshRequests++;
			if (!brokerAvailable) throw new Error("managed relay broker unavailable");
			return new Response(
				JSON.stringify({
					accessToken: refreshedAccessToken,
					accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
					tokenType: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) => {
						endpointDecorations++;
						return withRecordedRelayCredentialInstall(endpoint, relayInsertions, () => {
							endpointCloseCalls++;
						});
					},
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			await expect.poll(() => refreshRequests, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
			expect(relayInsertions).toEqual([]);

			brokerAvailable = true;
			await expect
				.poll(() => relayInsertions, { timeout: 5_000 })
				.toEqual([{ url: VOLT_PRODUCTION_RELAY_URLS[0], authToken: refreshedAccessToken }]);
			const statePath = getDaemonPaths(agentDir).statePath;
			await expect
				.poll(() => {
					const state = JSON.parse(readFileSync(statePath, "utf8")) as {
						settings: { relayCredential?: IrohManagedRelayCredential };
					};
					return state.settings.relayCredential?.accessToken;
				})
				.toBe(refreshedAccessToken);
			expect(endpointDecorations).toBe(1);
			expect(endpointCloseCalls).toBe(0);
			expect(originalCredential.accessTokenExpiresAt).toBeLessThan(Date.now());
		} finally {
			brokerAvailable = true;
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
				daemonStopped = true;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("refreshes and becomes ready when online stalls past the persisted JWT expiry", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-startup-valid-"));
		const originalCredential = await provisionManagedRelayCredentialState(agentDir, 1_500);
		const onlineGate = createDeferred();
		const relayInsertions: IrohRelayConfigLike[] = [];
		const relayRemovals: string[] = [];
		const refreshedAccessTokens: string[] = [];
		let brokerAvailable = false;
		let refreshRequests = 0;
		let onlineStarted = false;
		let onlineReleased = false;
		let endpointDecorations = 0;
		let endpointCloseCalls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/tokens/refresh`) {
				throw new Error(`unexpected managed relay credential request: ${url}`);
			}
			refreshRequests++;
			if (!brokerAvailable) throw new Error("managed relay broker unavailable");
			const accessToken = `refreshed${refreshedAccessTokens.length + 1}.payload.signature`;
			refreshedAccessTokens.push(accessToken);
			return new Response(
				JSON.stringify({
					accessToken,
					accessTokenExpiresAt: new Date(Date.now() + 31_000).toISOString(),
					tokenType: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		expect(originalCredential.accessTokenExpiresAt).toBeGreaterThan(Date.now());
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) => {
						endpointDecorations++;
						return withStalledOnline(
							withRecordedRelayCredentialInstall(
								endpoint,
								relayInsertions,
								() => {
									endpointCloseCalls++;
								},
								relayRemovals,
							),
							() => {
								onlineStarted = true;
							},
							onlineGate.promise,
						);
					},
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expectIrohEndpointReady(control);
			await expect.poll(() => onlineStarted, { timeout: 5_000 }).toBe(true);
			await expect.poll(() => refreshRequests, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
			await expect
				.poll(() => Date.now(), { timeout: 5_000 })
				.toBeGreaterThanOrEqual(originalCredential.accessTokenExpiresAt);
			await expect.poll(() => relayRemovals, { timeout: 5_000 }).toContain(VOLT_PRODUCTION_RELAY_URLS[0]);
			expect(relayInsertions).toEqual([]);
			expect(onlineReleased).toBe(false);

			brokerAvailable = true;
			await expect.poll(() => relayInsertions.length, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
			expect(refreshRequests).toBeGreaterThanOrEqual(3);
			expect(
				relayInsertions.every(
					(config) =>
						config.authToken !== originalCredential.accessToken &&
						config.authToken !== undefined &&
						refreshedAccessTokens.includes(config.authToken),
				),
			).toBe(true);
			const latestInsertedToken = relayInsertions[relayInsertions.length - 1]?.authToken;
			await expect
				.poll(() => {
					const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
						settings: { relayCredential?: IrohManagedRelayCredential };
					};
					return state.settings.relayCredential?.accessToken;
				})
				.toBe(latestInsertedToken);
			expect(endpointDecorations).toBe(1);
			expect(endpointCloseCalls).toBe(0);
			expect(onlineReleased).toBe(false);

			const shutdownStartedAt = Date.now();
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			expect(Date.now() - shutdownStartedAt).toBeLessThan(2_000);
			expect(endpointCloseCalls).toBe(1);
			expect(readFileSync(getDaemonPaths(agentDir).logPath, "utf8")).toContain(
				"extension dispose deadline exceeded after 50ms",
			);
			expect(onlineReleased).toBe(false);
		} finally {
			brokerAvailable = true;
			if (!daemonStopped) {
				onlineReleased = true;
				onlineGate.resolve();
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
				daemonStopped = true;
			}
			onlineReleased = true;
			onlineGate.resolve();
			await control?.close();
			fetchSpy.mockRestore();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh startup ownership", () => {
	it("keeps expired managed-claim cleanup inside startup admission during shutdown", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-expired-claim-shutdown-"));
		const credential = await provisionManagedRelayCredentialState(agentDir, 15 * 60_000);
		const statePath = getDaemonPaths(agentDir).statePath;
		const persistedState = JSON.parse(readFileSync(statePath, "utf8")) as {
			settings: Record<string, unknown>;
		};
		delete persistedState.settings.relayAuthToken;
		delete persistedState.settings.relayCredential;
		persistedState.settings.relayCredentialClaim = {
			schemaVersion: 1,
			serviceUrl: credential.serviceUrl,
			relayUrls: credential.relayUrls,
			hostNodeId: credential.endpointNodeId,
			claimSecret: `vpc_${"c".repeat(43)}`,
			bootstrapRefreshToken: `vrr_${"d".repeat(43)}`,
			claimId: "abcdefghijklmnopqrstuvwx",
			expiresAt: Date.now() - 60_000,
		};
		writeFileSync(statePath, `${JSON.stringify(persistedState, null, 2)}\n`);
		const startupLogOffset = readFileSync(getDaemonPaths(agentDir).logPath, "utf8").length;

		const cleanupFlushGate = createDeferred();
		let cleanupFlushStarted = false;
		let cleanupFlushFinished = false;
		let shutdownReachedIroh = false;
		let acceptNextCalls = 0;
		let onlineCalls = 0;
		let endpointCloseCalls = 0;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			(services) => {
				const flush = services.state.flush.bind(services.state);
				services.state.flush = async () => {
					if (!cleanupFlushStarted && services.state.state.settings.relayCredentialClaim === undefined) {
						cleanupFlushStarted = true;
						await cleanupFlushGate.promise;
						await flush();
						cleanupFlushFinished = true;
						return;
					}
					await flush();
				};
				return {
					async quiesce() {
						shutdownReachedIroh = true;
					},
				};
			},
			createIrohDaemonService(
				{},
				{
					decorateEndpoint: (endpoint) => ({
						id: () => endpoint.id(),
						addr: () => endpoint.addr(),
						async online() {
							onlineCalls++;
							await endpoint.online();
						},
						...(endpoint.insertRelay === undefined ? {} : { insertRelay: endpoint.insertRelay.bind(endpoint) }),
						...(endpoint.reconnectRelay === undefined
							? {}
							: { reconnectRelay: endpoint.reconnectRelay.bind(endpoint) }),
						...(endpoint.removeRelay === undefined ? {} : { removeRelay: endpoint.removeRelay.bind(endpoint) }),
						...(endpoint.watchHomeRelay === undefined
							? {}
							: { watchHomeRelay: endpoint.watchHomeRelay.bind(endpoint) }),
						acceptNext() {
							acceptNextCalls++;
							return endpoint.acceptNext();
						},
						secretKey: () => endpoint.secretKey(),
						async close() {
							endpointCloseCalls++;
							await endpoint.close();
						},
					}),
				},
			),
		]);

		try {
			const status = await waitForHealthyDaemon(agentDir);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect.poll(() => cleanupFlushStarted, { timeout: 5_000 }).toBe(true);
			expect(cleanupFlushFinished).toBe(false);
			expect(acceptNextCalls).toBe(0);

			let daemonSettled = false;
			void daemon.then(() => {
				daemonSettled = true;
			});
			expect((await control.request({ type: "shutdown" })).type).toBe("ok");
			await expect.poll(() => shutdownReachedIroh, { timeout: 5_000 }).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(cleanupFlushFinished).toBe(false);
			expect(daemonSettled).toBe(false);
			expect(acceptNextCalls).toBe(0);

			cleanupFlushGate.resolve();
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			expect(cleanupFlushFinished).toBe(true);
			expect(acceptNextCalls).toBe(0);
			expect(onlineCalls).toBe(0);
			expect(endpointCloseCalls).toBe(1);
			expect(readFileSync(getDaemonPaths(agentDir).logPath, "utf8").slice(startupLogOffset)).not.toContain(
				"iroh endpoint online",
			);
			const finalState = JSON.parse(readFileSync(statePath, "utf8")) as {
				settings: { relayCredentialClaim?: unknown };
			};
			expect(finalState.settings.relayCredentialClaim).toBeUndefined();
		} finally {
			cleanupFlushGate.resolve();
			if (!daemonStopped) {
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("bounds a native online tail without holding the durable quiesce barrier", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-startup-"));
		const onlineGate = createDeferred();
		let onlineStarted = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "development" },
				{
					decorateEndpoint: (endpoint) =>
						withStalledOnline(
							endpoint,
							() => {
								onlineStarted = true;
							},
							onlineGate.promise,
						),
				},
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect.poll(() => onlineStarted, { timeout: 15_000 }).toBe(true);

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;

			const paths = getDaemonPaths(agentDir);
			expect(existsSync(paths.pidfilePath)).toBe(false);
			expect(existsSync(paths.socketPath)).toBe(false);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
		} finally {
			onlineGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh control pairing ownership", () => {
	it("cancels pending pairing state before the final control connection closes", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-pairing-quiesce-"));
		const postIrohQuiesceGate = createDeferred();
		let postIrohQuiesceStarted = false;
		let daemonStopped = false;
		let pairingControl: DaemonClient | undefined;
		let shutdownControl: DaemonClient | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			createIrohDaemonService({ relayMode: "disabled" }),
			() => ({
				async quiesce() {
					postIrohQuiesceStarted = true;
					await postIrohQuiesceGate.promise;
				},
			}),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			pairingControl = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			shutdownControl = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});

			expect(await pairingControl.request({ type: "pair_request" })).toMatchObject({ type: "pair_started" });
			const paths = getDaemonPaths(agentDir);
			const pendingBeforeShutdown = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
				pendingPairingTickets: unknown[];
			};
			expect(pendingBeforeShutdown.pendingPairingTickets).toHaveLength(1);

			expect((await shutdownControl.request({ type: "shutdown" })).type).toBe("ok");
			await expect.poll(() => postIrohQuiesceStarted, { timeout: 15_000 }).toBe(true);
			// The pairing owner remains connected. Iroh quiesce, not a disconnect
			// callback from final controlServer.close(), must make the cut durable.
			expect(pairingControl.connectionState).toBe("connected");
			const stateAtDurableCut = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
				pendingPairingTickets: unknown[];
			};
			expect(stateAtDurableCut.pendingPairingTickets).toEqual([]);
			expect((await probeDaemon(agentDir)).state).toBe("shutting-down");

			postIrohQuiesceGate.resolve();
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const finalState = readFileSync(paths.statePath, "utf8");
			const finalAudit = readFileSync(paths.auditPath, "utf8");
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			expect(readFileSync(paths.statePath, "utf8")).toBe(finalState);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(finalAudit);
		} finally {
			postIrohQuiesceGate.resolve();
			if (!daemonStopped) {
				await shutdownControl?.request({ type: "shutdown" }).catch(() => {});
				await pairingControl?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await pairingControl?.close();
			await shutdownControl?.close();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("cancels managed relay claims with their pairing request and allows immediate replacement", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-managed-pair-cancel-"));
		const createdClaimIds: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims`) {
				const claimId = String(createdClaimIds.length + 1).padStart(24, "a");
				createdClaimIds.push(claimId);
				return new Response(
					JSON.stringify({ claimId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				);
			}
			if (
				url.startsWith(`${VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL}/v1/pairing-claims/`) &&
				url.endsWith("/exchange")
			) {
				return new Response(JSON.stringify({ status: "pending", retryAfterSeconds: 1 }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected managed relay credential request: ${url}`);
		});
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let activePairingRequestId: string | undefined;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [createIrohDaemonService()]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			const paths = getDaemonPaths(agentDir);
			const readPairingState = () =>
				JSON.parse(readFileSync(paths.statePath, "utf8")) as {
					pendingPairingTickets: unknown[];
					settings: { relayCredentialClaim?: { claimId: string } };
				};

			const firstPairing = await control.request({ type: "pair_request" });
			expect(firstPairing).toMatchObject({ type: "pair_started" });
			if (firstPairing.type !== "pair_started") throw new Error("first pairing did not start");
			activePairingRequestId = firstPairing.requestId;
			expect(readPairingState()).toMatchObject({
				pendingPairingTickets: [expect.any(Object)],
				settings: { relayCredentialClaim: { claimId: createdClaimIds[0] } },
			});

			expect(await control.request({ type: "pair_cancel", requestId: firstPairing.requestId })).toMatchObject({
				type: "ok",
			});
			activePairingRequestId = undefined;
			const cancelledState = readPairingState();
			expect(cancelledState.pendingPairingTickets).toEqual([]);
			expect(cancelledState.settings.relayCredentialClaim).toBeUndefined();

			const replacementPairing = await control.request({ type: "pair_request" });
			expect(replacementPairing).toMatchObject({ type: "pair_started" });
			if (replacementPairing.type !== "pair_started") throw new Error("replacement pairing did not start");
			activePairingRequestId = replacementPairing.requestId;
			expect(createdClaimIds).toHaveLength(2);
			expect(readPairingState()).toMatchObject({
				pendingPairingTickets: [expect.any(Object)],
				settings: { relayCredentialClaim: { claimId: createdClaimIds[1] } },
			});

			expect(await control.request({ type: "pair_cancel", requestId: replacementPairing.requestId })).toMatchObject({
				type: "ok",
			});
			activePairingRequestId = undefined;
			expect(readPairingState()).toMatchObject({ pendingPairingTickets: [], settings: {} });
		} finally {
			if (!daemonStopped) {
				if (activePairingRequestId !== undefined) {
					await control?.request({ type: "pair_cancel", requestId: activePairingRequestId }).catch(() => {});
				}
				await control?.request({ type: "shutdown" }).catch(() => {});
				await daemon;
				daemonStopped = true;
			}
			await control?.close();
			fetchSpy.mockRestore();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh pre-registration ownership", () => {
	it("joins a closed-gate refusal produced after the outer daemon disposal deadline", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-late-incoming-refusal-"));
		const incomingGate = createDeferred();
		const refuseGate = createDeferred();
		let acceptStarted = false;
		let refuseStarted = false;
		let refuseSettled = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const incoming: IrohIncomingLike = {
			async accept() {
				throw new Error("closed-gate incoming must not be accepted");
			},
			async refuse() {
				refuseStarted = true;
				await refuseGate.promise;
				refuseSettled = true;
			},
		};
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{
					decorateEndpoint: (endpoint) =>
						withDeferredIncoming(
							endpoint,
							incomingGate.promise,
							() => {
								acceptStarted = true;
							},
							incoming,
						),
				},
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect.poll(() => acceptStarted, { timeout: 15_000 }).toBe(true);

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const paths = getDaemonPaths(agentDir);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
			expect(refuseStarted).toBe(false);

			incomingGate.resolve();
			await expect.poll(() => refuseStarted).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(refuseSettled).toBe(false);
			expect(readFileSync(paths.logPath, "utf8")).not.toContain("iroh service stopped");

			refuseGate.resolve();
			await expect.poll(() => refuseSettled).toBe(true);
			await expect
				.poll(() => readFileSync(paths.logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
				.toBe(true);
		} finally {
			incomingGate.resolve();
			refuseGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("fences a deferred connection-task-limit refusal across daemon shutdown", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-connection-task-limit-"));
		const connectGate = createDeferred();
		const refuseGate = createDeferred();
		let connectStarted = 0;
		let refuseStarted = false;
		let refuseSettled = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const saturatedIncoming: IrohIncomingLike = {
			async accept() {
				return {
					async connect() {
						connectStarted++;
						await connectGate.promise;
						throw new Error("injected late saturated connect failure");
					},
				};
			},
			async refuse() {
				throw new Error("admitted connection task must not be refused");
			},
		};
		const deferredRefusal: IrohIncomingLike = {
			async accept() {
				throw new Error("connection-task-limit rejection must not accept the incoming");
			},
			async refuse() {
				refuseStarted = true;
				await refuseGate.promise;
				refuseSettled = true;
			},
		};
		const incomings = [
			...Array.from({ length: DEFAULT_IROH_REMOTE_RESOURCE_LIMITS.maxConnectionTasks }, () => saturatedIncoming),
			deferredRefusal,
		];
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{ decorateEndpoint: (endpoint) => withInjectedIncomings(endpoint, incomings) },
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect
				.poll(() => connectStarted, { timeout: 15_000 })
				.toBe(DEFAULT_IROH_REMOTE_RESOURCE_LIMITS.maxConnectionTasks);
			await expect.poll(() => refuseStarted, { timeout: 15_000 }).toBe(true);

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const paths = getDaemonPaths(agentDir);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");
			expect(auditAfterShutdown).not.toContain("incoming connection refused at daemon connection-task limit");

			refuseGate.resolve();
			await expect.poll(() => refuseSettled).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);

			connectGate.resolve();
			await expect
				.poll(() => readFileSync(paths.logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
				.toBe(true);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);
		} finally {
			refuseGate.resolve();
			connectGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("suppresses a late incoming-connect rejection after application quiesce", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-incoming-connect-"));
		const connectGate = createDeferred();
		let connectStarted = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const incoming: IrohIncomingLike = {
			async accept() {
				return {
					async connect() {
						connectStarted = true;
						await connectGate.promise;
						throw new Error("injected late incoming-connect failure");
					},
				};
			},
			async refuse() {},
		};
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{ decorateEndpoint: (endpoint) => withInjectedIncomings(endpoint, [incoming]) },
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect.poll(() => connectStarted, { timeout: 15_000 }).toBe(true);

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const paths = getDaemonPaths(agentDir);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");
			expect(auditAfterShutdown).not.toContain('"phase":"transport_connect"');

			connectGate.resolve();
			await expect
				.poll(() => readFileSync(paths.logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
				.toBe(true);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);
		} finally {
			connectGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("publishes a pre-registration rejection before a stalled connection.closed native tail", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-preregistration-reject-"));
		const connectionClosedGate = createDeferred();
		let closeRequested = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		const rejectedConnection: IrohConnectionLike = {
			remoteId: () => ({ toString: () => "rejected-pre-registration-node" }),
			acceptBi: () => Promise.reject(new Error("rejected connection must not accept streams")),
			setMaxConcurrentBiStreams() {
				throw new Error("injected stream-limit configuration failure");
			},
			close() {
				closeRequested = true;
			},
			closed: () => connectionClosedGate.promise,
		};
		const incoming: IrohIncomingLike = {
			async accept() {
				return { connect: () => Promise.resolve(rejectedConnection) };
			},
			async refuse() {},
		};
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{ decorateEndpoint: (endpoint) => withInjectedIncomings(endpoint, [incoming]) },
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await expect.poll(() => closeRequested, { timeout: 15_000 }).toBe(true);

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const paths = getDaemonPaths(agentDir);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");
			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");
			expect(auditAfterShutdown).toContain('"phase":"stream_limit_configuration"');

			connectionClosedGate.resolve();
			await expect
				.poll(() => readFileSync(paths.logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
				.toBe(true);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);
		} finally {
			connectionClosedGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			await control?.close();
			const logPath = getDaemonPaths(agentDir).logPath;
			if (existsSync(logPath)) {
				await expect
					.poll(() => readFileSync(logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
					.toBe(true);
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe.skipIf(!nativeAvailable)("voltd iroh native stream-tail ownership", () => {
	it("bounds a stalled accepted read after application quiesce and prevents late audit/state mutation", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-stream-tail-"));
		const workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		const readGate = createDeferred();
		let readStarted = false;
		let daemonStopped = false;
		let control: DaemonClient | undefined;
		let phone: PhoneEndpoint | undefined;
		let phoneConnection: PhoneConnection | undefined;
		const controlEvents: ControlEvent[] = [];
		const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
			createIrohDaemonService(
				{ relayMode: "disabled" },
				{
					decorateAcceptedStream: (stream) =>
						withStalledRead(
							stream,
							() => {
								readStarted = true;
							},
							readGate.promise,
						),
				},
			),
		]);

		try {
			let status: DaemonProbeResult = await probeDaemon(agentDir);
			for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await probeDaemon(agentDir);
			}
			expect(status.healthy).toBe(true);
			control = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
				onEvent: (event) => controlEvents.push(event),
			});
			expect(await control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).toMatchObject({
				type: "ok",
			});
			const pairStarted = await control.request({ type: "pair_request", workspaceName: "ws" });
			expect(pairStarted).toMatchObject({ type: "pair_started" });
			if (pairStarted.type !== "pair_started") throw new Error("pair request did not start");
			let ticket: string | undefined;
			await expect
				.poll(() => {
					const event = controlEvents.find(
						(candidate) => candidate.type === "pairing_progress" && candidate.phase === "ticket",
					);
					ticket = event?.type === "pairing_progress" ? event.ticket : undefined;
					return ticket;
				})
				.toBeTypeOf("string");
			const payload = decodeIrohRemoteTicketPayload(ticket as string);
			const iroh = native.iroh;
			if (!iroh) throw new Error("native iroh unavailable");
			const endpointTicket = (
				iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
			).fromString(payload.irohTicket);
			phone = await createPhoneEndpoint();
			phoneConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
			const stalledStream = await phoneConnection.openBi();
			await stalledStream.send.writeAll([123]);
			await expect.poll(() => readStarted).toBe(true);
			expect(await control.request({ type: "pair_cancel", requestId: pairStarted.requestId })).toMatchObject({
				type: "ok",
			});

			const shutdownResponse = await control.request({ type: "shutdown" });
			expect(shutdownResponse.type).toBe("ok");
			await expect(daemon).resolves.toBe(0);
			daemonStopped = true;
			const paths = getDaemonPaths(agentDir);
			expect(existsSync(paths.pidfilePath)).toBe(false);
			expect(existsSync(paths.socketPath)).toBe(false);
			expect(readFileSync(paths.logPath, "utf8")).toContain("extension dispose deadline exceeded after 50ms");

			const auditAfterShutdown = readFileSync(paths.auditPath, "utf8");
			const stateAfterShutdown = readFileSync(paths.statePath, "utf8");
			readGate.resolve();
			await expect
				.poll(() => readFileSync(paths.logPath, "utf8").includes("iroh service stopped"), { timeout: 5_000 })
				.toBe(true);
			expect(readFileSync(paths.auditPath, "utf8")).toBe(auditAfterShutdown);
			expect(readFileSync(paths.statePath, "utf8")).toBe(stateAfterShutdown);
		} finally {
			readGate.resolve();
			if (!daemonStopped && control !== undefined) {
				await control.request({ type: "shutdown" }).catch(() => {});
				await daemon;
			}
			phoneConnection?.close(0n, Array.from(Buffer.from("done", "utf8")));
			await phone?.close().catch(() => {});
			await control?.close();
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});
