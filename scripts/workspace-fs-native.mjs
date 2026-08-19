#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_VERSION = "volt-workspace-fs-v1";
const EXPECTED_EXPORTS = ["WorkspaceRoot", "workspaceFsApiVersion", "workspaceFsSourceFingerprint"];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "packages", "coding-agent", "native", "workspace-fs");
const prebuilds = join(crate, "prebuilds");
const manifestPath = join(prebuilds, "manifest.json");
const require = createRequire(import.meta.url);

const targets = {
	"darwin-arm64": { rust: "aarch64-apple-darwin", library: "libvolt_workspace_fs.dylib" },
	"darwin-x64": { rust: "x86_64-apple-darwin", library: "libvolt_workspace_fs.dylib" },
	"linux-arm64-gnu": { rust: "aarch64-unknown-linux-gnu", library: "libvolt_workspace_fs.so" },
	"linux-arm64-musl": { rust: "aarch64-unknown-linux-musl", library: "libvolt_workspace_fs.so" },
	"linux-x64-gnu": { rust: "x86_64-unknown-linux-gnu", library: "libvolt_workspace_fs.so" },
	"linux-x64-musl": { rust: "x86_64-unknown-linux-musl", library: "libvolt_workspace_fs.so" },
	"win32-arm64-msvc": { rust: "aarch64-pc-windows-msvc", library: "volt_workspace_fs.dll" },
	"win32-x64-msvc": { rust: "x86_64-pc-windows-msvc", library: "volt_workspace_fs.dll" },
};

function fail(message) {
	throw new Error(message);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = options.capture ? `\n${result.stderr || result.stdout}`.trimEnd() : "";
		fail(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
	}
	return options.capture ? result.stdout.trim() : "";
}

function cargoCommand() {
	if (process.env.CARGO) return { command: process.env.CARGO, env: process.env };
	const direct = spawnSync("cargo", ["--version"], { encoding: "utf8" });
	if (!direct.error && direct.status === 0) return { command: "cargo", env: process.env };
	const cargo = run("rustup", ["which", "--toolchain", "1.97.1", "cargo"], { capture: true });
	return {
		command: cargo,
		env: { ...process.env, PATH: `${dirname(cargo)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
	};
}

function cargo(args, options = {}) {
	const resolved = cargoCommand();
	return run(resolved.command, args, { cwd: crate, env: resolved.env, capture: options.capture });
}

function sourceFiles() {
	const files = ["Cargo.lock", "Cargo.toml", "build.rs", "deny.toml", "rust-toolchain.toml"].map((name) =>
		join(crate, name),
	);
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(path);
		}
	};
	visit(join(crate, "src"));
	return files.sort();
}

function sourceFingerprint() {
	const hash = createHash("sha256");
	for (const file of sourceFiles()) {
		const name = relative(crate, file).replaceAll("\\", "/");
		const bytes = readFileSync(file);
		const nameLength = Buffer.alloc(8);
		nameLength.writeBigUInt64BE(BigInt(Buffer.byteLength(name)));
		const byteLength = Buffer.alloc(8);
		byteLength.writeBigUInt64BE(BigInt(bytes.length));
		hash.update(nameLength).update(name).update(byteLength).update(bytes);
	}
	return hash.digest("hex");
}

function currentTarget() {
	if (process.arch !== "arm64" && process.arch !== "x64") fail(`Unsupported native architecture: ${process.arch}`);
	if (process.platform === "darwin") return `darwin-${process.arch}`;
	if (process.platform === "win32") return `win32-${process.arch}-msvc`;
	if (process.platform === "linux") {
		const report = process.report.getReport();
		const libc = typeof report.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
		return `linux-${process.arch}-${libc}`;
	}
	fail(`Unsupported native platform: ${process.platform}`);
}

function artifactPath(target) {
	return join(prebuilds, target, "workspace-fs.node");
}

function build(target) {
	const config = targets[target];
	if (!config) fail(`Unknown workspace-fs target: ${target}`);
	cargo(["build", "--release", "--locked", "--target", config.rust]);
	const built = join(crate, "target", config.rust, "release", config.library);
	if (!existsSync(built)) fail(`Cargo did not produce ${built}`);
	const destination = artifactPath(target);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(built, destination);
	chmodSync(destination, 0o644);
	console.log(`Built ${relative(root, destination)}`);
}

function artifactRecord(target) {
	const destination = artifactPath(target);
	if (!existsSync(destination) || !statSync(destination).isFile()) return undefined;
	return {
		target,
		path: `${target}/workspace-fs.node`,
		sha256: `sha256:${createHash("sha256").update(readFileSync(destination)).digest("hex")}`,
	};
}

function writeManifest(allowPartial) {
	const artifacts = Object.keys(targets).map(artifactRecord).filter(Boolean);
	if (!allowPartial && artifacts.length !== Object.keys(targets).length) {
		const found = new Set(artifacts.map((artifact) => artifact.target));
		fail(`Missing workspace-fs prebuilds: ${Object.keys(targets).filter((target) => !found.has(target)).join(", ")}`);
	}
	mkdirSync(prebuilds, { recursive: true });
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				apiVersion: API_VERSION,
				sourceFingerprint: sourceFingerprint(),
				artifacts,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Wrote ${relative(root, manifestPath)} with ${artifacts.length} artifact(s)`);
}

function verifyAddon(addonPath, manifest) {
	const addon = require(addonPath);
	const exports = Object.keys(addon).sort();
	if (JSON.stringify(exports) !== JSON.stringify(EXPECTED_EXPORTS)) {
		fail(`Unexpected native exports for ${addonPath}: ${exports.join(", ")}`);
	}
	if (addon.workspaceFsApiVersion() !== manifest.apiVersion) fail(`API mismatch for ${addonPath}`);
	if (addon.workspaceFsSourceFingerprint() !== manifest.sourceFingerprint) {
		fail(`Source fingerprint mismatch for ${addonPath}`);
	}
	const fixture = join(tmpdir(), `volt-workspace-fs-smoke-${process.pid}-${Date.now()}`);
	mkdirSync(fixture, { recursive: true });
	try {
		const workspace = new addon.WorkspaceRoot(resolve(fixture));
		workspace.close();
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

function verify(allowPartial) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.schemaVersion !== 1 || manifest.apiVersion !== API_VERSION) fail("Native manifest schema or API mismatch");
	const fingerprint = sourceFingerprint();
	if (manifest.sourceFingerprint !== fingerprint) {
		fail(`Native manifest source fingerprint is stale: expected ${fingerprint}, found ${manifest.sourceFingerprint}`);
	}
	const expectedTargets = Object.keys(targets);
	const records = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
	if (!allowPartial && records.length !== expectedTargets.length) fail("Native manifest must contain all eight targets");
	const seen = new Set();
	for (const artifact of records) {
		if (!targets[artifact.target] || seen.has(artifact.target)) fail(`Invalid or duplicate target ${artifact.target}`);
		seen.add(artifact.target);
		if (artifact.path !== `${artifact.target}/workspace-fs.node`) fail(`Unexpected path for ${artifact.target}`);
		const file = join(prebuilds, artifact.path);
		const digest = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
		if (artifact.sha256 !== digest) fail(`Checksum mismatch for ${artifact.target}`);
	}
	if (!allowPartial && expectedTargets.some((target) => !seen.has(target))) fail("Native manifest target set is incomplete");
	const native = currentTarget();
	const current = records.find((artifact) => artifact.target === native);
	if (current) verifyAddon(join(prebuilds, current.path), manifest);
	else if (!allowPartial) fail(`Native manifest has no loadable artifact for ${native}`);
	console.log(`Verified workspace-fs manifest (${records.length} artifact(s))`);
}

function licenseInventory() {
	const metadata = JSON.parse(cargo(["metadata", "--locked", "--format-version", "1"], { capture: true }));
	const overridesPath = join(root, "compliance", "rust-license-overrides.json");
	const overridesDocument = JSON.parse(readFileSync(overridesPath, "utf8"));
	if (overridesDocument.schemaVersion !== 1 || typeof overridesDocument.packages !== "object") {
		fail(`Rust license override configuration is malformed: ${overridesPath}`);
	}
	const overrides = overridesDocument.packages;
	const usedOverrides = new Set();
	const packages = metadata.packages
		.filter((entry) => entry.name !== "volt-workspace-fs")
		.map((entry) => {
			const packageRoot = dirname(entry.manifest_path);
			let licenseFiles = readdirSync(packageRoot, { withFileTypes: true })
				.filter((file) => file.isFile() && /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file.name))
				.map((file) => ({ name: file.name, source: join(packageRoot, file.name) }))
				.sort((left, right) => left.name.localeCompare(right.name));
			if (typeof entry.license !== "string") fail(`Rust dependency ${entry.name}@${entry.version} has no declared license`);
			const identity = `${entry.name}@${entry.version}`;
			const override = overrides[identity];
			if (licenseFiles.length === 0) {
				if (!override || !Array.isArray(override.files) || override.files.length === 0 || typeof override.source !== "string") {
					fail(`Rust dependency ${identity} has no top-level license text or checksum-pinned override`);
				}
				usedOverrides.add(identity);
				licenseFiles = override.files.map((file) => {
					if (typeof file.path !== "string" || !/^[0-9a-f]{64}$/.test(String(file.sha256))) {
						fail(`Rust license override is malformed for ${identity}`);
					}
					const source = resolve(root, file.path);
					const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
					if (digest !== file.sha256) fail(`Rust license override checksum mismatch for ${identity}: ${file.path}`);
					return { name: source.split(/[\\/]/).at(-1), source };
				});
			}
			const directory = `${entry.name.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}-${entry.version}`;
			return {
				name: entry.name,
				version: entry.version,
				declaredLicense: entry.license,
				license: override?.selectedLicense ?? entry.license,
				directory,
				licenseFiles,
			};
		})
		.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
	const configuredOverrides = Object.keys(overrides).sort();
	if (JSON.stringify([...usedOverrides].sort()) !== JSON.stringify(configuredOverrides)) {
		fail("Rust license override set contains an unused or missing package identity");
	}
	return {
		schemaVersion: 1,
		sourceFingerprint: sourceFingerprint(),
		cargoLockSha256: createHash("sha256").update(readFileSync(join(crate, "Cargo.lock"))).digest("hex"),
		packages,
	};
}

function generateLicenses() {
	const inventory = licenseInventory();
	const output = join(crate, "licenses");
	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });
	const packages = inventory.packages.map((entry) => {
		const destinationDirectory = join(output, entry.directory);
		mkdirSync(destinationDirectory, { recursive: true });
		return {
			name: entry.name,
			version: entry.version,
			declaredLicense: entry.declaredLicense,
			license: entry.license,
			licenseFiles: entry.licenseFiles.map((file) => {
				const destination = join(destinationDirectory, file.name);
				copyFileSync(file.source, destination);
				const bytes = readFileSync(destination);
				return {
					path: `${entry.directory}/${file.name}`,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			}),
		};
	});
	writeFileSync(
		join(output, "inventory.json"),
		`${JSON.stringify(
			{
				schemaVersion: inventory.schemaVersion,
				sourceFingerprint: inventory.sourceFingerprint,
				cargoLockSha256: inventory.cargoLockSha256,
				packages,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Generated ${packages.length} Rust dependency license records`);
}

function verifyLicenses() {
	const output = join(crate, "licenses");
	const inventoryPath = join(output, "inventory.json");
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
	const expected = licenseInventory();
	if (
		inventory.schemaVersion !== 1 ||
		inventory.sourceFingerprint !== expected.sourceFingerprint ||
		inventory.cargoLockSha256 !== expected.cargoLockSha256 ||
		!Array.isArray(inventory.packages)
	) {
		fail("Rust dependency license inventory header is stale or malformed");
	}
	const expectedIdentities = expected.packages.map((entry) => `${entry.name}@${entry.version}`);
	const actualIdentities = inventory.packages.map((entry) => `${entry.name}@${entry.version}`);
	if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
		fail("Rust dependency license inventory package set is stale");
	}
	const expectedFiles = new Set(["inventory.json"]);
	for (const entry of inventory.packages) {
		if (!Array.isArray(entry.licenseFiles) || entry.licenseFiles.length === 0) {
			fail(`Rust dependency license record has no texts: ${entry.name}@${entry.version}`);
		}
		for (const file of entry.licenseFiles) {
			expectedFiles.add(file.path);
			const digest = createHash("sha256").update(readFileSync(join(output, file.path))).digest("hex");
			if (digest !== file.sha256) fail(`Rust dependency license checksum mismatch: ${file.path}`);
		}
	}
	const actualFiles = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile()) actualFiles.push(relative(output, entryPath).replaceAll("\\", "/"));
			else fail(`Rust dependency license tree contains a non-file entry: ${entryPath}`);
		}
	};
	visit(output);
	actualFiles.sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
		fail("Rust dependency license file set does not match inventory.json");
	}
	console.log(`Verified ${inventory.packages.length} Rust dependency license records`);
}

function check() {
	cargo(["fmt", "--all", "--", "--check"]);
	cargo(["clippy", "--all-targets", "--", "-D", "warnings"]);
	cargo(["test", "--locked"]);
	verify(false);
	verifyLicenses();
}

function usage() {
	console.log(`Usage: node scripts/workspace-fs-native.mjs <command> [options]\n\nCommands:\n  build [target]        Build the current or named target\n  manifest [--allow-partial]\n  verify [--allow-partial]\n  licenses              Generate Rust third-party license texts and inventory\n  verify-licenses       Verify the generated Rust license set\n  check                 Run formatting, clippy, tests, artifact, and license verification\n  fingerprint           Print the source/Cargo fingerprint\n  target                Print the current native target`);
}

const [command, argument] = process.argv.slice(2);
try {
	if (command === "build") build(argument ?? currentTarget());
	else if (command === "manifest") writeManifest(argument === "--allow-partial");
	else if (command === "verify") verify(argument === "--allow-partial");
	else if (command === "licenses") generateLicenses();
	else if (command === "verify-licenses") verifyLicenses();
	else if (command === "check") check();
	else if (command === "fingerprint") console.log(sourceFingerprint());
	else if (command === "target") console.log(currentTarget());
	else {
		usage();
		if (command) process.exitCode = 1;
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
}
