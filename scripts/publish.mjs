#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertPublishedPackageMatchesRelease,
	NPM_PUBLISHED_METADATA_FIELDS,
	verifyPublishedPackageAfterPublish,
} from "./npm-publish-verification.mjs";

const packages = [
	{ directory: "packages/ai", name: "@hansjm10/volt-ai" },
	{ directory: "packages/agent", name: "@hansjm10/volt-agent-core" },
	{ directory: "packages/tui", name: "@hansjm10/volt-tui" },
	{
		directory: "packages/coding-agent",
		name: "@hansjm10/volt-coding-agent",
		requiredPackFiles: ["dist/remote/iroh-native-adapter.cjs"],
	},
];
const NPM_DIST_TAG = "latest";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(pkg) {
	const directory = pkg.directory;
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	const packedPaths = new Set(packed.files.map((file) => file.path));
	for (const requiredFile of pkg.requiredPackFiles ?? []) {
		if (!packedPaths.has(requiredFile)) {
			throw new Error(`${pkg.name} pack output is missing required file: ${requiredFile}. Run npm run build before publishing.`);
		}
	}
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	return packed;
}

function getPublishedMetadata(name, version) {
	const result = spawnSync(
		commandForPlatform("npm"),
		[
			"view",
			`${name}@${version}`,
			...NPM_PUBLISHED_METADATA_FIELDS,
			"--json",
		],
		{
			encoding: "utf8",
			stdio: ["inherit", "pipe", "pipe"],
		},
	);

	if (result.status === 0 && result.stdout.trim()) {
		return JSON.parse(result.stdout);
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return undefined;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}
	packageVersions.set(pkg.name, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing volt packages at ${versions[0]} with npm dist-tag ${NPM_DIST_TAG}${dryRun ? " (dry run)" : ""}\n`);

for (const pkg of packages) {
	const version = packageVersions.get(pkg.name);
	assertBuildOutputExists(pkg.directory);
	const packed = validatePack(pkg);
	const publishedMetadata = getPublishedMetadata(pkg.name, version);

	if (dryRun) {
		if (publishedMetadata) {
			assertPublishedPackageMatchesRelease({
				name: pkg.name,
				version,
				directory: pkg.directory,
				sourceCommit,
				packed,
				metadata: publishedMetadata,
			});
			console.log(`${pkg.name}@${version} is already published and matches this release.`);
		} else {
			console.log(`${pkg.name}@${version} is not published; package contents are valid for publish.`);
		}
		console.log();
		continue;
	}

	if (publishedMetadata) {
		assertPublishedPackageMatchesRelease({
			name: pkg.name,
			version,
			directory: pkg.directory,
			sourceCommit,
			packed,
			metadata: publishedMetadata,
		});
		console.log(`Skipping ${pkg.name}@${version}: already published from this exact release\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts", "--tag", NPM_DIST_TAG], {
		cwd: pkg.directory,
	});
	verifyPublishedPackageAfterPublish({
		name: pkg.name,
		version,
		directory: pkg.directory,
		sourceCommit,
		packed,
	}, getPublishedMetadata);
	console.log();
}
