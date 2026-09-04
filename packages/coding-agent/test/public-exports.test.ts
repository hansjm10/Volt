import { describe, expect, it } from "vitest";
import * as sessionManagerSource from "../src/core/session-manager.ts";
import * as publicExports from "../src/index.ts";

describe("public exports", () => {
	it("exports the Iroh remote control listener used by the host entrypoint", () => {
		expect(publicExports.listenIrohRemoteControlServer).toBeTypeOf("function");
	});

	it("keeps in-memory JSONL import internal to the session-manager module", () => {
		expect(sessionManagerSource.importSessionFromJsonlInMemory).toBeTypeOf("function");
		expect(publicExports).not.toHaveProperty("importSessionFromJsonlInMemory");
		expect(publicExports.SessionManager).not.toHaveProperty("importFromJsonlInMemory");
	});
});
