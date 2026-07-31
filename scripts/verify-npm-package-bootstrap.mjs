#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PACKAGES, versionFromReleaseTag } from "./verify-release-provenance.mjs";

export const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
export const INITIAL_BETA_VERSION = "0.1.0";

function usage() {
	return "Usage: node scripts/verify-npm-package-bootstrap.mjs <preflight|tag> --version X.Y.Z [--initial]";
}

export function parseBootstrapVerificationArgs(args) {
	const [mode, ...rest] = args;
	if (mode !== "preflight" && mode !== "tag") throw new Error(usage());

	let version;
	let initial = false;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--initial") {
			initial = true;
			continue;
		}
		if (arg === "--version") {
			version = rest[++index];
			if (!version) throw new Error("--version requires a value");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}\n${usage()}`);
	}

	if (!version) throw new Error(usage());
	versionFromReleaseTag(`v${version}`);
	if (initial && (mode !== "preflight" || version !== INITIAL_BETA_VERSION)) {
		throw new Error("--initial is only valid for the preflight of the 0.1.0 release");
	}
	return { initial, mode, version };
}

function normalizedVersions(metadata) {
	if (Array.isArray(metadata.versions)) return metadata.versions;
	return typeof metadata.versions === "string" ? [metadata.versions] : [];
}

function validatePackageIdentity(expectedName, metadata) {
	if (metadata.name !== expectedName) {
		throw new Error(`npm returned unexpected package identity for ${expectedName}: ${String(metadata.name)}`);
	}
}

function verifyEstablishedPackageChannels(expectedName, versions, metadata) {
	const distTags = metadata["dist-tags"];
	if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
		throw new Error(`${expectedName} has malformed npm dist-tags metadata`);
	}
	if (!versions.includes(INITIAL_BETA_VERSION) || distTags.beta !== INITIAL_BETA_VERSION) {
		throw new Error(`${expectedName} must preserve the historical beta dist-tag on ${INITIAL_BETA_VERSION}`);
	}
	if (distTags.bootstrap !== BOOTSTRAP_VERSION) {
		throw new Error(`${expectedName} must keep bootstrap on the inert placeholder`);
	}
	if (distTags.latest !== BOOTSTRAP_VERSION && !versions.includes(distTags.latest)) {
		throw new Error(`${expectedName} latest must point to a published stable version or the inert placeholder`);
	}
}

export function verifyPreflightPackageMetadata(expectedName, targetVersion, metadata, options = {}) {
	validatePackageIdentity(expectedName, metadata);
	const versions = normalizedVersions(metadata);
	if (versions.includes(targetVersion)) {
		throw new Error(`${expectedName}@${targetVersion} is already published; refusing to create or replace its release tag`);
	}

	if (!options.initial) {
		verifyEstablishedPackageChannels(expectedName, versions, metadata);
		return;
	}
	if (versions.length !== 1 || versions[0] !== BOOTSTRAP_VERSION) {
		throw new Error(`${expectedName} must contain only placeholder version ${BOOTSTRAP_VERSION} before the initial release`);
	}
	const distTags = metadata["dist-tags"];
	if (
		!distTags ||
		typeof distTags !== "object" ||
		Array.isArray(distTags) ||
		Object.keys(distTags).length !== 2 ||
		distTags.bootstrap !== BOOTSTRAP_VERSION ||
		distTags.latest !== BOOTSTRAP_VERSION
	) {
		throw new Error(
			`${expectedName} must keep bootstrap and npm-required latest on ${BOOTSTRAP_VERSION}; beta must be absent before the initial release`,
		);
	}
}

export function verifyTagWorkflowPackageMetadata(expectedName, targetVersion, metadata) {
	validatePackageIdentity(expectedName, metadata);
	const versions = normalizedVersions(metadata);
	if (targetVersion === INITIAL_BETA_VERSION) {
		if (!versions.includes(targetVersion)) {
			verifyPreflightPackageMetadata(expectedName, targetVersion, metadata, { initial: true });
			return;
		}
		if (metadata["dist-tags"]?.beta !== targetVersion) {
			throw new Error(`${expectedName}@${targetVersion} is published but beta does not point to it`);
		}
		if (
			metadata["dist-tags"]?.bootstrap !== BOOTSTRAP_VERSION ||
			metadata["dist-tags"]?.latest !== BOOTSTRAP_VERSION
		) {
			throw new Error(`${expectedName}@${targetVersion} must keep bootstrap and latest on the inert placeholder`);
		}
		return;
	}

	verifyEstablishedPackageChannels(expectedName, versions, metadata);
	if (versions.includes(targetVersion) && metadata["dist-tags"].latest !== targetVersion) {
		throw new Error(`${expectedName}@${targetVersion} is published but latest does not point to it`);
	}
}

export function npmViewPackageMetadata(name, run = spawnSync) {
	const npmArgs = [
		"view",
		`${name}@${BOOTSTRAP_VERSION}`,
		"name",
		"versions",
		"dist-tags",
		"--json",
		"--registry=https://registry.npmjs.org/",
	];
	const result = process.platform === "win32"
		? run(process.execPath, [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...npmArgs], {
				encoding: "utf8",
				timeout: 30_000,
			})
		: run("npm", npmArgs, {
				encoding: "utf8",
				timeout: 30_000,
			});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			throw new Error(
				`${name}@${BOOTSTRAP_VERSION} does not exist on npm. The name is either unreserved or contains unexpected content; follow docs/npm-release-bootstrap.md.`,
			);
		}
		throw new Error(output || `npm view failed for ${name}`);
	}
	return JSON.parse(result.stdout);
}

function main() {
	const options = parseBootstrapVerificationArgs(process.argv.slice(2));
	for (const directory of RELEASE_PACKAGES) {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		const metadata = npmViewPackageMetadata(manifest.name);
		if (options.mode === "preflight") {
			verifyPreflightPackageMetadata(manifest.name, options.version, metadata, { initial: options.initial });
		} else {
			verifyTagWorkflowPackageMetadata(manifest.name, options.version, metadata);
		}
		process.stdout.write(`npm ${options.mode} verification passed: ${manifest.name}@${options.version}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`npm release bootstrap verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
