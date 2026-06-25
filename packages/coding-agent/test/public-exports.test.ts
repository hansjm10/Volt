import { describe, expect, it } from "vitest";
import { listenIrohRemoteControlServer } from "../src/index.ts";

describe("public exports", () => {
	it("exports the Iroh remote control listener used by the host entrypoint", () => {
		expect(listenIrohRemoteControlServer).toBeTypeOf("function");
	});
});
