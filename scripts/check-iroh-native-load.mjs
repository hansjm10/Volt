#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve } from "node:path";

const EXPECTED_IROH_VERSION = "1.1.1-volt.2";

function parseArgs(args) {
	if (args.length === 0) return { from: process.cwd() };
	if (args.length === 2 && args[0] === "--from" && args[1]) {
		return { from: resolve(args[1]) };
	}
	throw new Error("Usage: node scripts/check-iroh-native-load.mjs [--from <install-directory>]");
}

const options = parseArgs(process.argv.slice(2));
const requireFromInstall = createRequire(resolve(options.from, "package.json"));
const packageManifest = requireFromInstall("@hansjm10/volt-iroh/package.json");
if (packageManifest.version !== EXPECTED_IROH_VERSION) {
	throw new Error(
		`Expected @hansjm10/volt-iroh@${EXPECTED_IROH_VERSION}, found ${String(packageManifest.version)}`,
	);
}
const iroh = requireFromInstall("@hansjm10/volt-iroh/index.js");
if (typeof iroh?.bindingCapabilities !== "function") {
	throw new Error("The selected Volt Iroh binding does not expose bindingCapabilities()");
}
const capabilities = iroh.bindingCapabilities();
if (capabilities.connectedHomeRelayWatch !== true || capabilities.reconnectRelay !== true) {
	throw new Error(`The selected Volt Iroh binding lacks required relay recovery capabilities: ${JSON.stringify(capabilities)}`);
}
if (typeof iroh?.Endpoint?.builder !== "function") {
	throw new Error("The selected Volt Iroh binding does not expose Endpoint.builder()");
}
console.log(
	`Loaded @hansjm10/volt-iroh@${packageManifest.version} for ${process.platform}-${process.arch} with relay recovery support.`,
);
