import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient, DaemonClientOptions, DistributiveOmit } from "../src/daemon/control-client.ts";
import type { ControlRequest, ControlResponse, RemoteTransportHealth } from "../src/daemon/control-protocol.ts";

const mockDaemon = vi.hoisted(() => ({
	requestTypes: [] as string[],
	remoteTransport: {
		state: "degraded",
		reasonCode: "host_storage_full",
	} as RemoteTransportHealth,
}));

vi.mock("../src/daemon/spawn.ts", () => ({
	ensureDaemonRunning: vi.fn(async () => ({
		healthy: true,
		state: "running",
		socketPath: "/tmp/voltd-test.sock",
		authToken: "test-token",
		pid: 42,
	})),
	probeDaemon: vi.fn(async () => ({
		healthy: true,
		state: "running",
		socketPath: "/tmp/voltd-test.sock",
		authToken: "test-token",
		pid: 42,
	})),
}));

vi.mock("../src/daemon/control-client.ts", () => ({
	createDaemonClient: (_options: DaemonClientOptions): DaemonClient => ({
		connectionState: "connected",
		serverInfo: undefined,
		goneReason: undefined,
		async connect() {},
		async request(request: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse> {
			mockDaemon.requestTypes.push(request.type);
			if (request.type === "status") {
				return {
					type: "status_result",
					id: "status-1",
					version: "test",
					protocolVersion: 1,
					pid: 42,
					startedAtMs: 0,
					leases: [],
					phoneConnections: 0,
					workspaces: [{ name: "volt", path: "/tmp/volt" }],
					clients: [],
					remoteTransport: mockDaemon.remoteTransport,
					keepAwake: { enabled: false, state: "disabled" },
				};
			}
			return {
				type: "error",
				id: "pair-1",
				code: "pair_failed",
				message: "pair request observed",
			};
		},
		async waitForResponse() {
			throw new Error("not used");
		},
		async openRelay() {
			throw new Error("not used");
		},
		async close() {},
	}),
}));

import { handleRemoteControlCommand } from "../src/daemon/remote-cli.ts";

describe("remote pair CLI transport availability", () => {
	let originalExitCode: typeof process.exitCode;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		mockDaemon.requestTypes.length = 0;
		mockDaemon.remoteTransport = { state: "degraded", reasonCode: "host_storage_full" };
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errorSpy.mockRestore();
		process.exitCode = originalExitCode;
	});

	function loggedErrors(): string {
		return errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
	}

	it("sends a pairing retry while storage-full degradation is recoverable", async () => {
		await expect(
			handleRemoteControlCommand(["remote", "pair", "--workspace", "volt"], {
				isStandaloneBinary: false,
			}),
		).resolves.toBe(true);

		expect(mockDaemon.requestTypes).toEqual(["status", "pair_request"]);
		expect(loggedErrors()).toContain("pair request observed");
		expect(loggedErrors()).not.toContain("phone transport is degraded");
	});

	it("blocks pairing when storage-full degradation is unavailable", async () => {
		mockDaemon.remoteTransport = {
			state: "unavailable",
			reasonCode: "host_storage_full",
			message: "Computer storage is full. Free space on the computer, then retry.",
		};

		await handleRemoteControlCommand(["remote", "pair", "--workspace", "volt"], {
			isStandaloneBinary: false,
		});

		expect(mockDaemon.requestTypes).toEqual(["status"]);
		expect(loggedErrors()).toContain("phone transport is unavailable");
	});
});
