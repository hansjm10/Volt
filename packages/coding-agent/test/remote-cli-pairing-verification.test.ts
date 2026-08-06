import { describe, expect, it } from "vitest";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import { encodeIrohRemoteTicketPayload } from "../src/core/remote/iroh/ticket.ts";
import { formatRemotePairingVerificationLines } from "../src/daemon/remote-cli.ts";

describe("remote pair CLI verification output", () => {
	it("formats full comparable fields without decoding ticket secrets", () => {
		const hostNodeId = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
		const ticket = encodeIrohRemoteTicketPayload({
			alpn: IROH_REMOTE_ALPN,
			expiresAt: 1_800_000_000_000,
			irohTicket: "endpoint-ticket",
			nodeId: hostNodeId,
			relay: {
				kind: "custom-uncredentialed",
				origins: ["https://relay-a.example:8443", "https://relay-b.example"],
			},
			secret: "pairing-secret-must-not-render",
			workspace: "volt",
		});
		const output = formatRemotePairingVerificationLines(ticket).join("\n");

		expect(output).toContain("630DCD29-66C43366-91125448-BBB25B4F");
		expect(output).toContain(hostNodeId);
		expect(output).toContain("Workspace\n    volt");
		expect(output).toContain("Relay mode\n    production");
		expect(output).toContain("https://relay-a.example:8443");
		expect(output).toContain("https://relay-b.example");
		expect(output).toContain("2027-01-15T08:00:00.000Z");
		expect(output).not.toContain("pairing-secret-must-not-render");
	});
});
