import { describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import {
	canonicalizePersistedIrohRemoteAllowTools,
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
} from "../src/core/remote/iroh/protocol.ts";

describe("canonicalizePersistedIrohRemoteAllowTools", () => {
	it("keeps absent grants absent", () => {
		expect(canonicalizePersistedIrohRemoteAllowTools(undefined)).toBeUndefined();
	});

	it("canonicalizes the exact default grant to absent", () => {
		expect(canonicalizePersistedIrohRemoteAllowTools(DEFAULT_IROH_REMOTE_ALLOW_TOOLS)).toBeUndefined();
	});

	it("treats reordered, duplicated, and whitespace-padded default grants as default", () => {
		const reordered = DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(",").reverse().join(", ");
		expect(canonicalizePersistedIrohRemoteAllowTools(reordered)).toBeUndefined();
		const duplicated = `${DEFAULT_IROH_REMOTE_ALLOW_TOOLS},read, bash`;
		expect(canonicalizePersistedIrohRemoteAllowTools(duplicated)).toBeUndefined();
	});

	it("persists a subset as a normalized deduplicated list", () => {
		expect(canonicalizePersistedIrohRemoteAllowTools(" grep , read ,read")).toBe("grep,read");
	});

	it("persists a superset of the default grant", () => {
		const superset = `${DEFAULT_IROH_REMOTE_ALLOW_TOOLS},custom_extension_tool`;
		expect(canonicalizePersistedIrohRemoteAllowTools(superset)).toBe(
			`${DEFAULT_IROH_REMOTE_ALLOW_TOOLS},custom_extension_tool`,
		);
	});

	it("persists deny-all as the empty string, never conflating it with absent", () => {
		expect(canonicalizePersistedIrohRemoteAllowTools("")).toBe("");
		expect(canonicalizePersistedIrohRemoteAllowTools(" , ")).toBe("");
	});

	it("maps presets onto the persistence representation", () => {
		expect(
			canonicalizePersistedIrohRemoteAllowTools(createIrohRemotePresetAccess("coding").allowedTools),
		).toBeUndefined();
		expect(
			canonicalizePersistedIrohRemoteAllowTools(createIrohRemotePresetAccess("full").allowedTools),
		).toBeUndefined();
		expect(canonicalizePersistedIrohRemoteAllowTools(createIrohRemotePresetAccess("review").allowedTools)).toBe(
			"read,grep,find,ls",
		);
		expect(canonicalizePersistedIrohRemoteAllowTools(createIrohRemotePresetAccess("chat").allowedTools)).toBe("");
	});
});
