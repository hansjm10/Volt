import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import {
	encodeIrohRemoteTicketPayload,
	formatIrohRemoteHostFingerprint,
	getIrohRemotePairingVerificationDetails,
} from "../src/core/remote/iroh/ticket.ts";

const ENDPOINT_ID_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);
const ENDPOINT_ID = Buffer.from(ENDPOINT_ID_BYTES).toString("hex");

function pairingTicket(
	overrides: {
		relay?: { kind: "disabled" } | { kind: "n0-public" } | { kind: "custom-uncredentialed"; origins: string[] };
	} = {},
) {
	return encodeIrohRemoteTicketPayload({
		alpn: IROH_REMOTE_ALPN,
		expiresAt: 1_800_000_000_000,
		irohTicket: "endpoint-ticket",
		nodeId: ENDPOINT_ID,
		relay: {
			kind: "custom-uncredentialed",
			origins: ["https://relay-a.example:8443", "https://relay-b.example"],
		},
		secret: "pairing-secret-must-not-render",
		workspace: "  volt-workspace  ",
		...overrides,
	});
}

describe("Iroh pairing verification details", () => {
	it("matches the iOS endpoint identity fingerprint test vector", () => {
		expect(formatIrohRemoteHostFingerprint(ENDPOINT_ID_BYTES)).toBe("630DCD29-66C43366-91125448-BBB25B4F");
	});

	it("returns canonical comparable fields without ticket secrets", () => {
		const details = getIrohRemotePairingVerificationDetails(pairingTicket());
		expect(details).toEqual({
			expiresAt: 1_800_000_000_000,
			hostFingerprint: "630DCD29-66C43366-91125448-BBB25B4F",
			hostNodeId: ENDPOINT_ID,
			relayMode: "production",
			relayOrigins: ["https://relay-a.example:8443", "https://relay-b.example"],
			workspace: "volt-workspace",
		});
		const rendered = JSON.stringify(details);
		expect(rendered).not.toContain("pairing-secret-must-not-render");
	});

	it("rejects relay descriptors that the iOS confirmation refuses", () => {
		expect(() =>
			getIrohRemotePairingVerificationDetails(
				pairingTicket({ relay: { kind: "custom-uncredentialed", origins: ["https://127.0.0.1"] } }),
			),
		).toThrow("must not target a local or private host");
		expect(() =>
			getIrohRemotePairingVerificationDetails(
				pairingTicket({ relay: { kind: "n0-public", origins: ["https://relay.example"] } } as never),
			),
		).toThrow("unknown field");
	});

	it("requires an exact 32-byte endpoint identity", () => {
		expect(() => formatIrohRemoteHostFingerprint(Uint8Array.of(1, 2, 3))).toThrow("exactly 32 bytes");
	});
});
