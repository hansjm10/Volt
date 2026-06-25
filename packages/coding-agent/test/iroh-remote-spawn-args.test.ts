import { describe, expect, it } from "vitest";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	getIrohRemoteVoltRpcToolArgs,
	parseIrohRemoteAllowTools,
	usesDefaultIrohRemoteAllowTools,
} from "../src/core/remote/iroh/index.ts";

describe("Iroh remote spawned Volt RPC tool arguments", () => {
	it("marks default remote grants as allowing unlisted extension tools", () => {
		expect(parseIrohRemoteAllowTools(undefined)).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
		expect(usesDefaultIrohRemoteAllowTools(undefined)).toBe(true);
		expect(getIrohRemoteVoltRpcToolArgs(undefined)).toEqual([
			"--tools",
			DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			"--allow-unlisted-extension-tools",
		]);
	});

	it("treats equivalent default allowlists as default grants", () => {
		const reorderedDefaultTools = "ls, find, grep, write, edit, bash, read";

		expect(usesDefaultIrohRemoteAllowTools(reorderedDefaultTools)).toBe(true);
		expect(getIrohRemoteVoltRpcToolArgs(reorderedDefaultTools)).toEqual([
			"--tools",
			"ls,find,grep,write,edit,bash,read",
			"--allow-unlisted-extension-tools",
		]);
	});

	it("keeps explicit non-default allowlists strict", () => {
		expect(usesDefaultIrohRemoteAllowTools("read,grep")).toBe(false);
		expect(getIrohRemoteVoltRpcToolArgs("read, grep")).toEqual(["--tools", "read,grep"]);
	});

	it("falls back to default grants for empty allowlists", () => {
		expect(parseIrohRemoteAllowTools(" , ")).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
		expect(getIrohRemoteVoltRpcToolArgs(" , ")).toEqual([
			"--tools",
			DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
			"--allow-unlisted-extension-tools",
		]);
	});
});
