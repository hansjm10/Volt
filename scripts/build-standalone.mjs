#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import postject from "postject";

const SEA_SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ALLOWED_EXTERNAL_PACKAGES = new Set(["bufferutil", "supports-color", "utf-8-validate"]);
const OUTPUT_SENTINEL = ".volt-release-output-v1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentRoot = join(repoRoot, "packages", "coding-agent");
const workspaceFsRoot = join(codingAgentRoot, "native", "workspace-fs");
const defaultOutputDirectory = join(codingAgentRoot, "binaries");
const runtimeConfigPath = join(repoRoot, "compliance", "standalone-runtime.json");
const pythonCommand = process.env.VOLT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const cjsRequire = createRequire(import.meta.url);

function usage() {
	console.log(`Usage: node scripts/build-standalone.mjs [options]

Build the Volt standalone archive for the current native platform.

Options:
  --target <target>            Native target (defaults to the current platform)
  --out <directory>            Release output directory
  --node-archive <file>        Use a local official Node archive instead of downloading it
  --source-date-epoch <epoch>  Archive timestamp (defaults to SOURCE_DATE_EPOCH or HEAD)
  --stage-assets-only          Stage and smoke-test release assets without building an archive
  --help                       Show this help`);
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			options.help = true;
			continue;
		}
		if (argument === "--stage-assets-only") {
			options.stage_assets_only = true;
			continue;
		}
		if (!["--target", "--out", "--node-archive", "--source-date-epoch"].includes(argument)) {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		options[argument.slice(2).replaceAll("-", "_")] = value;
		index += 1;
	}
	return options;
}

function nativeTarget() {
	const architecture = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
	if (!architecture) throw new Error(`Unsupported native architecture: ${process.arch}`);
	if (process.platform === "darwin") return `darwin-${architecture}`;
	if (process.platform === "linux") return `linux-${architecture}`;
	if (process.platform === "win32") return `windows-${architecture}`;
	throw new Error(`Unsupported native platform: ${process.platform}`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = options.capture ? `\n${result.stderr || result.stdout}`.trimEnd() : "";
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${details}`);
	}
	return options.capture ? result.stdout.trim() : "";
}

function sha256File(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function download(url, destination, redirectsRemaining = 5) {
	return new Promise((resolveDownload, reject) => {
		const request = get(url, (response) => {
			if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				if (redirectsRemaining === 0) {
					reject(new Error(`Too many redirects while downloading ${url}`));
					return;
				}
				const redirectUrl = new URL(response.headers.location, url);
				if (redirectUrl.protocol !== "https:") {
					reject(new Error(`Refusing non-HTTPS redirect while downloading ${url}`));
					return;
				}
				download(redirectUrl.href, destination, redirectsRemaining - 1).then(resolveDownload, reject);
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
				return;
			}
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => {
				writeFileSync(destination, Buffer.concat(chunks), { mode: 0o644 });
				resolveDownload();
			});
		});
		request.on("error", reject);
	});
}

function isPathInside(parent, child) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function prepareOutputDirectory(requestedDirectory) {
	const requested = resolve(requestedDirectory ?? defaultOutputDirectory);
	if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) {
		throw new Error(`Refusing symlink release output directory: ${requested}`);
	}
	const realRepoRoot = realpathSync(repoRoot);
	const realDefault = realpathSync(dirname(defaultOutputDirectory));
	const resolvedDefault = join(realDefault, basename(defaultOutputDirectory));
	const output = existsSync(requested) ? realpathSync(requested) : requested;
	if (output === sep || output === realRepoRoot || isPathInside(output, realRepoRoot)) {
		throw new Error(`Refusing release output directory that contains the repository: ${output}`);
	}
	if (isPathInside(realRepoRoot, output) && output !== resolvedDefault) {
		throw new Error(`Custom release output directories must be outside the repository: ${output}`);
	}
	if (existsSync(output) && !statSync(output).isDirectory()) {
		throw new Error(`Release output path is not a directory: ${output}`);
	}
	if (existsSync(output) && output !== resolvedDefault && !existsSync(join(output, OUTPUT_SENTINEL))) {
		if (readdirSync(output).length > 0) {
			throw new Error(`Refusing non-empty custom output without ${OUTPUT_SENTINEL}: ${output}`);
		}
	}
	mkdirSync(output, { recursive: true, mode: 0o755 });
	writeFileSync(join(output, OUTPUT_SENTINEL), "", { mode: 0o644 });
	return output;
}

function assertRequiredFile(path) {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Required release file is missing: ${path}`);
}

function copyTrackedTree(sourceRoot, destinationRoot, excludedPaths = []) {
	const repoRelativeRoot = relative(repoRoot, sourceRoot).replaceAll("\\", "/");
	const tracked = run("git", ["ls-files", "-z", "--", `${repoRelativeRoot}/`], { capture: true })
		.split("\0")
		.filter(Boolean)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	if (tracked.length === 0) throw new Error(`Release asset tree has no tracked files: ${sourceRoot}`);
	for (const trackedPath of tracked) {
		const sourceRelativePath = trackedPath.slice(repoRelativeRoot.length + 1);
		if (
			excludedPaths.some(
				(excluded) => sourceRelativePath === excluded || sourceRelativePath.startsWith(`${excluded}/`),
			)
		) {
			continue;
		}
		const source = join(repoRoot, ...trackedPath.split("/"));
		const sourceStat = lstatSync(source);
		if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || !isPathInside(realpathSync(sourceRoot), realpathSync(source))) {
			throw new Error(`Tracked release asset must be a regular in-tree file: ${trackedPath}`);
		}
		const destination = join(destinationRoot, ...sourceRelativePath.split("/"));
		mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
		copyFileSync(source, destination);
	}
}

function workspaceFsTarget(target) {
	if (target.startsWith("darwin-")) return target;
	if (target.startsWith("linux-")) return `${target}-gnu`;
	if (target.startsWith("windows-")) return `win32-${target.slice("windows-".length)}-msvc`;
	throw new Error(`Unsupported standalone workspace-fs target: ${target}`);
}

function collectRegularFiles(directory) {
	const files = [];
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const metadata = lstatSync(path);
			if (metadata.isSymbolicLink()) throw new Error(`Native release assets must not contain symlinks: ${path}`);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(relative(directory, path).replaceAll("\\", "/"));
			else throw new Error(`Native release asset is not a regular file: ${path}`);
		}
	};
	visit(directory);
	return files.sort();
}

function copyWorkspaceFsAssets(stageDirectory, target) {
	const nativeTarget = workspaceFsTarget(target);
	const sourcePrebuilds = join(workspaceFsRoot, "prebuilds");
	const sourceManifest = join(sourcePrebuilds, "manifest.json");
	assertRequiredFile(sourceManifest);
	const manifest = JSON.parse(readFileSync(sourceManifest, "utf8"));
	if (
		manifest.schemaVersion !== 1 ||
		typeof manifest.apiVersion !== "string" ||
		!/^[0-9a-f]{64}$/.test(manifest.sourceFingerprint) ||
		!Array.isArray(manifest.artifacts)
	) {
		throw new Error("Workspace filesystem native manifest is malformed");
	}
	const matches = manifest.artifacts.filter((artifact) => artifact.target === nativeTarget);
	if (matches.length !== 1) throw new Error(`Workspace filesystem manifest must contain exactly one ${nativeTarget} artifact`);
	const artifact = matches[0];
	if (
		artifact.path !== `${nativeTarget}/workspace-fs.node` ||
		!/^sha256:[0-9a-f]{64}$/.test(artifact.sha256)
	) {
		throw new Error(`Workspace filesystem artifact record is malformed for ${nativeTarget}`);
	}
	const sourceAddon = join(sourcePrebuilds, ...artifact.path.split("/"));
	assertRequiredFile(sourceAddon);
	const sourceBytes = readFileSync(sourceAddon);
	const digest = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
	if (digest !== artifact.sha256) throw new Error(`Workspace filesystem addon checksum mismatch for ${nativeTarget}`);

	const destinationPrebuilds = join(stageDirectory, "native", "workspace-fs", "prebuilds");
	const destinationAddon = join(destinationPrebuilds, ...artifact.path.split("/"));
	mkdirSync(dirname(destinationAddon), { recursive: true, mode: 0o755 });
	copyFileSync(sourceAddon, destinationAddon);
	chmodSync(destinationAddon, 0o644);
	writeFileSync(
		join(destinationPrebuilds, "manifest.json"),
		`${JSON.stringify({ ...manifest, artifacts: [artifact] }, null, 2)}\n`,
		{ mode: 0o644 },
	);

	const sourceLicenses = join(workspaceFsRoot, "licenses");
	const inventoryPath = join(sourceLicenses, "inventory.json");
	assertRequiredFile(inventoryPath);
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
	if (
		inventory.schemaVersion !== 1 ||
		inventory.sourceFingerprint !== manifest.sourceFingerprint ||
		!Array.isArray(inventory.packages)
	) {
		throw new Error("Workspace filesystem Rust license inventory is malformed or stale");
	}
	const expectedLicenseFiles = new Set(["inventory.json"]);
	for (const dependency of inventory.packages) {
		if (!Array.isArray(dependency.licenseFiles) || dependency.licenseFiles.length === 0) {
			throw new Error(`Workspace filesystem Rust license record has no texts: ${dependency.name}@${dependency.version}`);
		}
		for (const license of dependency.licenseFiles) {
			if (typeof license.path !== "string" || !/^[0-9a-f]{64}$/.test(license.sha256)) {
				throw new Error(`Workspace filesystem Rust license record is malformed: ${dependency.name}@${dependency.version}`);
			}
			const source = join(sourceLicenses, ...license.path.split("/"));
			const licenseBytes = readFileSync(source);
			if (createHash("sha256").update(licenseBytes).digest("hex") !== license.sha256) {
				throw new Error(`Workspace filesystem Rust license checksum mismatch: ${license.path}`);
			}
			expectedLicenseFiles.add(license.path);
		}
	}
	const actualLicenseFiles = collectRegularFiles(sourceLicenses);
	if (JSON.stringify(actualLicenseFiles) !== JSON.stringify([...expectedLicenseFiles].sort())) {
		throw new Error("Workspace filesystem Rust license tree does not exactly match inventory.json");
	}
	const destinationLicenses = join(stageDirectory, "LICENSES", "workspace-fs-rust");
	for (const licensePath of actualLicenseFiles) {
		const destination = join(destinationLicenses, ...licensePath.split("/"));
		mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
		copyFileSync(join(sourceLicenses, ...licensePath.split("/")), destination);
	}
}

function assertStagedWorkspaceFsAddon(stageDirectory, target) {
	const nativeTarget = workspaceFsTarget(target);
	const prebuilds = join(stageDirectory, "native", "workspace-fs", "prebuilds");
	const manifest = JSON.parse(readFileSync(join(prebuilds, "manifest.json"), "utf8"));
	if (manifest.artifacts.length !== 1 || manifest.artifacts[0].target !== nativeTarget) {
		throw new Error(`Standalone workspace filesystem manifest does not contain only ${nativeTarget}`);
	}
	const addonPath = join(prebuilds, ...manifest.artifacts[0].path.split("/"));
	const addon = cjsRequire(addonPath);
	const exports = Object.keys(addon).sort();
	const expectedExports = ["WorkspaceRoot", "workspaceFsApiVersion", "workspaceFsSourceFingerprint"];
	if (JSON.stringify(exports) !== JSON.stringify(expectedExports)) {
		throw new Error(`Standalone workspace filesystem addon exports are invalid: ${exports.join(", ")}`);
	}
	if (
		addon.workspaceFsApiVersion() !== manifest.apiVersion ||
		addon.workspaceFsSourceFingerprint() !== manifest.sourceFingerprint
	) {
		throw new Error("Standalone workspace filesystem addon fingerprint does not match its manifest");
	}
	const root = new addon.WorkspaceRoot(stageDirectory);
	root.close();
}

function copyReleaseAssets(stageDirectory, target) {
	for (const name of [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"THIRD-PARTY-NOTICES.md",
		"BINARY-CAPABILITIES.md",
		"npm-shrinkwrap.json",
	]) {
		const source = join(codingAgentRoot, name);
		assertRequiredFile(source);
		copyFileSync(source, join(stageDirectory, name));
	}

	const themeSource = join(codingAgentRoot, "dist", "core", "theme");
	const themeDestination = join(stageDirectory, "theme");
	if (!existsSync(themeSource)) throw new Error(`Required release asset directory is missing: ${themeSource}`);
	mkdirSync(themeDestination, { recursive: true, mode: 0o755 });
	for (const name of readdirSync(themeSource).filter((name) => name.endsWith(".json"))) {
		copyFileSync(join(themeSource, name), join(themeDestination, name));
	}

	const exportSource = join(codingAgentRoot, "dist", "core", "export-html");
	const exportDestination = join(stageDirectory, "export-html");
	const vendorDestination = join(exportDestination, "vendor");
	mkdirSync(vendorDestination, { recursive: true, mode: 0o755 });
	for (const name of ["template.html", "template.css", "template.js"]) {
		const source = join(exportSource, name);
		assertRequiredFile(source);
		copyFileSync(source, join(exportDestination, name));
	}
	for (const name of ["highlight.min.js", "marked.min.js"]) {
		const source = join(exportSource, "vendor", name);
		assertRequiredFile(source);
		copyFileSync(source, join(vendorDestination, name));
	}

	const docsSource = join(codingAgentRoot, "docs");
	copyTrackedTree(docsSource, join(stageDirectory, "docs"), ["images/doom-extension.png"]);

	const examplesRoot = join(codingAgentRoot, "examples");
	const excludedExamples = [
		"extensions/doom-overlay",
		"remote/iroh-sidecar",
		"remote/firebase-push-relay/functions/node_modules",
	];
	copyTrackedTree(examplesRoot, join(stageDirectory, "examples"), excludedExamples);
	copyFileSync(join(examplesRoot, "README.binary.md"), join(stageDirectory, "examples", "README.md"));
	rmSync(join(stageDirectory, "examples", "README.binary.md"), { force: true });

	if (target.startsWith("darwin-")) {
		const helper = join(
			repoRoot,
			"packages",
			"tui",
			"native",
			"darwin",
			"prebuilds",
			target,
			"darwin-modifiers.node",
		);
		assertRequiredFile(helper);
		const destination = join(stageDirectory, "native", "darwin", "prebuilds", target);
		mkdirSync(destination, { recursive: true, mode: 0o755 });
		copyFileSync(helper, join(destination, "darwin-modifiers.node"));
	}
	if (target.startsWith("windows-")) {
		const architectureDirectory = target === "windows-arm64" ? "win32-arm64" : "win32-x64";
		const helper = join(
			repoRoot,
			"packages",
			"tui",
			"native",
			"win32",
			"prebuilds",
			architectureDirectory,
			"win32-console-mode.node",
		);
		assertRequiredFile(helper);
		const destination = join(stageDirectory, "native", "win32", "prebuilds", architectureDirectory);
		mkdirSync(destination, { recursive: true, mode: 0o755 });
		copyFileSync(helper, join(destination, "win32-console-mode.node"));
	}
	copyWorkspaceFsAssets(stageDirectory, target);
}

function assertNoSymlinks(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (lstatSync(path).isSymbolicLink()) throw new Error(`Release staging must not contain symlinks: ${path}`);
		if (entry.isDirectory()) assertNoSymlinks(path);
	}
}

function assertExternalImports(metafile) {
	const bundledNativeInputs = Object.keys(metafile.inputs ?? {}).filter((path) => /\.(?:node|wasm)(?:$|\?)/.test(path));
	if (bundledNativeInputs.length > 0) {
		throw new Error(`Standalone JavaScript bundles contain native/WASM inputs:\n${bundledNativeInputs.sort().join("\n")}`);
	}
	const unexpected = new Set();
	for (const output of Object.values(metafile.outputs ?? {})) {
		for (const externalImport of output.imports ?? []) {
			if (!externalImport.external || isBuiltin(externalImport.path)) continue;
			if (
				externalImport.path === "@hansjm10/volt-iroh" ||
				externalImport.path.startsWith("@hansjm10/volt-iroh/") ||
				ALLOWED_EXTERNAL_PACKAGES.has(externalImport.path)
			) {
				continue;
			}
			unexpected.add(externalImport.path);
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Unexpected external imports in standalone bundle:\n${[...unexpected].sort().join("\n")}`);
	}
	const bundledIroh = Object.keys(metafile.inputs ?? {}).filter((path) =>
		path.replaceAll("\\", "/").includes("node_modules/@hansjm10/volt-iroh/"),
	);
	if (bundledIroh.length > 0) {
		throw new Error(`The standalone bundle embedded @hansjm10/volt-iroh:\n${bundledIroh.join("\n")}`);
	}
}

function assertStagedBinarySidecars(stageDirectory, target) {
	const expectedNativeSidecars = [
		`native/workspace-fs/prebuilds/${workspaceFsTarget(target)}/workspace-fs.node`,
	];
	if (target.startsWith("darwin-")) {
		expectedNativeSidecars.push(`native/darwin/prebuilds/${target}/darwin-modifiers.node`);
	} else if (target.startsWith("windows-")) {
		expectedNativeSidecars.push(
			`native/win32/prebuilds/${target === "windows-arm64" ? "win32-arm64" : "win32-x64"}/win32-console-mode.node`,
		);
	}
	const nativeSidecars = [];
	const wasmFiles = [];
	const unexpectedBinaryFiles = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				const stagedPath = relative(stageDirectory, path).replaceAll("\\", "/");
				if (entry.name.endsWith(".node")) nativeSidecars.push(stagedPath);
				if (entry.name.endsWith(".wasm")) wasmFiles.push(stagedPath);
				if (/\.(?:a|class|dylib|jar|lib|o|so|zip)$/i.test(entry.name)) unexpectedBinaryFiles.push(stagedPath);
				if (entry.name.endsWith(".dll") || (entry.name.endsWith(".exe") && stagedPath !== "volt.exe")) {
					unexpectedBinaryFiles.push(stagedPath);
				}
			}
		}
	};
	visit(stageDirectory);
	if (wasmFiles.length > 0) throw new Error(`Standalone staging contains unexpected WASM files:\n${wasmFiles.sort().join("\n")}`);
	if (unexpectedBinaryFiles.length > 0) {
		throw new Error(`Standalone staging contains unexpected binary files:\n${unexpectedBinaryFiles.sort().join("\n")}`);
	}
	const expected = expectedNativeSidecars.sort();
	if (JSON.stringify(nativeSidecars.sort()) !== JSON.stringify(expected)) {
		throw new Error(
			`Standalone native sidecars do not match the target allowlist. Expected ${expected.join(", ")}; found ${nativeSidecars.join(", ") || "none"}`,
		);
	}
}

function normalizedArchiveFileMode(stagedPath, statMode) {
	// Windows reports ordinary files as 0666 through Node, while the archive
	// writer makes the shipped executable 0755 and all other files 0644.
	// Record the normalized archive mode so the manifest describes the bytes
	// and metadata testers actually extract on every platform.
	return stagedPath === "volt.exe" || (statMode & 0o111) !== 0 ? "0755" : "0644";
}

function writeStagedFileManifest(stageDirectory) {
	const manifestName = "standalone-file-manifest.json";
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				const stagedPath = relative(stageDirectory, path).replaceAll("\\", "/");
				if (stagedPath === manifestName) continue;
				const bytes = readFileSync(path);
				const stat = statSync(path);
				files.push({
					path: stagedPath,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					size: stat.size,
					mode: normalizedArchiveFileMode(stagedPath, stat.mode),
				});
			}
		}
	};
	visit(stageDirectory);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	writeFileSync(join(stageDirectory, manifestName), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, {
		mode: 0o644,
	});
}

async function bundleStandalone(scratchDirectory, stageDirectory) {
	const entryPoint = join(codingAgentRoot, "dist", "sea", "cli.js");
	assertRequiredFile(entryPoint);
	const bundlePath = join(scratchDirectory, "volt.cjs");
	const result = await esbuild.build({
		absWorkingDir: repoRoot,
		entryPoints: {
			volt: entryPoint,
			"image-resize-worker": join(codingAgentRoot, "src", "utils", "image-resize-worker.ts"),
		},
		outdir: scratchDirectory,
		outExtension: { ".js": ".cjs" },
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node26",
		metafile: true,
		logLevel: "info",
		legalComments: "none",
		define: {
			__VOLT_STANDALONE__: "true",
			"import.meta.resolve": "undefined",
			"import.meta.url": "undefined",
		},
		external: ["@hansjm10/volt-iroh", "@hansjm10/volt-iroh/*", ...ALLOWED_EXTERNAL_PACKAGES],
	});
	assertExternalImports(result.metafile);

	const metafilePath = join(stageDirectory, "binary-metafile.json");
	writeFileSync(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`, { mode: 0o644 });
	copyFileSync(join(scratchDirectory, "image-resize-worker.cjs"), join(stageDirectory, "image-resize-worker.cjs"));

	const licenseDirectory = join(stageDirectory, "LICENSES");
	mkdirSync(licenseDirectory, { recursive: true, mode: 0o755 });
	run(process.execPath, [
		join(repoRoot, "scripts", "collect-binary-licenses.mjs"),
		"--metafile",
		metafilePath,
		"--out",
		join(licenseDirectory, "npm"),
		"--manifest",
		join(stageDirectory, "binary-license-manifest.json"),
	]);
	return { bundlePath, metafilePath };
}

async function extractNodeRuntime(runtime, targetConfig, nodeArchiveOption, temporaryDirectory) {
	const archivePath = nodeArchiveOption
		? resolve(nodeArchiveOption)
		: join(temporaryDirectory, targetConfig.archive);
	if (nodeArchiveOption) assertRequiredFile(archivePath);
	else {
		const url = `${runtime.releaseBaseUrl}/${targetConfig.archive}`;
		console.log(`Downloading ${url}`);
		await download(url, archivePath);
	}
	const archiveSha256 = await sha256File(archivePath);
	if (archiveSha256 !== targetConfig.sha256) {
		throw new Error(
			`Official Node archive checksum mismatch for ${basename(archivePath)}: expected ${targetConfig.sha256}, received ${archiveSha256}`,
		);
	}

	const extractionDirectory = join(temporaryDirectory, "node-runtime");
	mkdirSync(extractionDirectory, { recursive: true, mode: 0o755 });
	if (process.platform === "win32") {
		run(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Expand-Archive -LiteralPath $env:VOLT_NODE_ARCHIVE -DestinationPath $env:VOLT_NODE_RUNTIME -Force",
			],
			{
				env: {
					VOLT_NODE_ARCHIVE: archivePath,
					VOLT_NODE_RUNTIME: extractionDirectory,
				},
			},
		);
	} else {
		run("tar", ["-xf", archivePath, "-C", extractionDirectory]);
	}
	const archiveRoot = targetConfig.archive.replace(/\.(?:tar\.gz|tar\.xz|zip)$/, "");
	const executable = targetConfig.archive.includes("-win-")
		? join(extractionDirectory, archiveRoot, "node.exe")
		: join(extractionDirectory, archiveRoot, "bin", "node");
	assertRequiredFile(executable);
	const version = run(executable, ["--version"], { capture: true });
	if (version !== `v${runtime.version}`) {
		throw new Error(`Extracted Node runtime reported ${version}, expected v${runtime.version}`);
	}
	return { executable, archiveSha256 };
}

async function build() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const runtime = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
	if (runtime.runtime !== "node" || runtime.version !== "26.8.1") {
		throw new Error("Standalone runtime config must pin Node.js 26.8.1");
	}
	const currentTarget = nativeTarget();
	const target = options.target ?? currentTarget;
	if (target !== currentTarget) {
		throw new Error(`Standalone builds are native-only: requested ${target}, current platform is ${currentTarget}`);
	}
	const targetConfig = runtime.targets?.[target];
	if (!targetConfig) throw new Error(`Target is not configured in ${runtimeConfigPath}: ${target}`);
	const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true });
	const sourceTreeClean = run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true }) === "";
	if (process.env.VOLT_REQUIRE_CLEAN_SOURCE === "1" && !sourceTreeClean) {
		throw new Error("Standalone release build requires a clean tracked source tree");
	}

	const outputDirectory = prepareOutputDirectory(options.out);
	const stageDirectory = join(outputDirectory, target);
	const archiveExtension = target.startsWith("windows-") ? "zip" : "tar.gz";
	const archivePath = join(outputDirectory, `volt-${target}.${archiveExtension}`);
	const scratchDirectory = join(repoRoot, ".standalone-build", target);
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "volt-standalone-"));
	rmSync(stageDirectory, { recursive: true, force: true });
	rmSync(archivePath, { force: true });
	rmSync(scratchDirectory, { recursive: true, force: true });
	mkdirSync(stageDirectory, { recursive: true, mode: 0o755 });
	mkdirSync(scratchDirectory, { recursive: true, mode: 0o755 });

	try {
		copyReleaseAssets(stageDirectory, target);
		assertStagedWorkspaceFsAddon(stageDirectory, target);
		if (options.stage_assets_only) {
			assertNoSymlinks(stageDirectory);
			assertStagedBinarySidecars(stageDirectory, target);
			writeStagedFileManifest(stageDirectory);
			console.log(`Staged and smoke-tested ${stageDirectory}`);
			return;
		}
		const { bundlePath, metafilePath } = await bundleStandalone(scratchDirectory, stageDirectory);
		const { executable: nodeExecutable, archiveSha256 } = await extractNodeRuntime(
			runtime,
			targetConfig,
			options.node_archive,
			temporaryDirectory,
		);

		const nodeLicense = resolve(repoRoot, runtime.license.path);
		assertRequiredFile(nodeLicense);
		const nodeLicenseSha256 = await sha256File(nodeLicense);
		if (nodeLicenseSha256 !== runtime.license.sha256) {
			throw new Error(`Node runtime license checksum mismatch: expected ${runtime.license.sha256}, received ${nodeLicenseSha256}`);
		}
		const licensesDirectory = join(stageDirectory, "LICENSES");
		copyFileSync(nodeLicense, join(licensesDirectory, `node-v${runtime.version}-LICENSE.txt`));
		const highlightLicense = join(codingAgentRoot, "src", "core", "export-html", "vendor", "highlight.LICENSE");
		assertRequiredFile(highlightLicense);
		copyFileSync(highlightLicense, join(licensesDirectory, "highlight.js-11.9.0-BSD-3-Clause.txt"));
		const markedLicense = join(codingAgentRoot, "src", "core", "export-html", "vendor", "marked.LICENSE");
		assertRequiredFile(markedLicense);
		copyFileSync(markedLicense, join(licensesDirectory, "marked-18.0.5-LICENSE.txt"));

		const standaloneExecutable = join(stageDirectory, target.startsWith("windows-") ? "volt.exe" : "volt");
		copyFileSync(nodeExecutable, standaloneExecutable);
		if (!target.startsWith("windows-")) chmodSync(standaloneExecutable, statSync(standaloneExecutable).mode | 0o111);
		if (target.startsWith("darwin-")) run("codesign", ["--remove-signature", standaloneExecutable]);

		const seaBlobPath = join(scratchDirectory, "sea-prep.blob");
		const seaConfigPath = join(scratchDirectory, "sea-config.json");
		writeFileSync(
			seaConfigPath,
			`${JSON.stringify(
				{
					main: basename(bundlePath),
					output: basename(seaBlobPath),
					disableExperimentalSEAWarning: true,
					useSnapshot: false,
					useCodeCache: false,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o644 },
		);
		run(nodeExecutable, ["--experimental-sea-config", basename(seaConfigPath)], { cwd: scratchDirectory });
		await postject.inject(standaloneExecutable, "NODE_SEA_BLOB", readFileSync(seaBlobPath), {
			sentinelFuse: SEA_SENTINEL_FUSE,
			machoSegmentName: "NODE_SEA",
		});
		if (target.startsWith("darwin-")) {
			run("codesign", ["--sign", "-", "--force", "--timestamp=none", standaloneExecutable]);
		}
		const packageJson = JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8"));
		const standaloneVersion = run(standaloneExecutable, ["--version"], { capture: true });
		if (standaloneVersion !== packageJson.version) {
			throw new Error(`Standalone smoke test reported version ${standaloneVersion}, expected ${packageJson.version}`);
		}

		const buildManifest = {
			schemaVersion: 1,
			target,
			sourceCommit,
			sourceTreeClean,
			runtime: {
				name: runtime.runtime,
				version: runtime.version,
				archive: targetConfig.archive,
				archiveSha256,
				license: `LICENSES/node-v${runtime.version}-LICENSE.txt`,
				licenseSha256: nodeLicenseSha256,
			},
			sea: {
				useSnapshot: false,
				useCodeCache: false,
			},
			bundleMetafile: basename(metafilePath),
			binaryLicenseManifest: "binary-license-manifest.json",
			fileManifest: "standalone-file-manifest.json",
		};
		writeFileSync(join(stageDirectory, "standalone-build-manifest.json"), `${JSON.stringify(buildManifest, null, 2)}\n`, {
			mode: 0o644,
		});

		if (existsSync(join(stageDirectory, "examples", "extensions", "doom-overlay"))) {
			throw new Error("Doom overlay must not be present in standalone release staging");
		}
		assertNoSymlinks(stageDirectory);
		assertStagedBinarySidecars(stageDirectory, target);
		writeStagedFileManifest(stageDirectory);

		let epoch = options.source_date_epoch ?? process.env.SOURCE_DATE_EPOCH;
		if (!epoch) epoch = run("git", ["show", "-s", "--format=%ct", "HEAD"], { capture: true });
		if (!/^\d+$/.test(epoch)) throw new Error(`Invalid SOURCE_DATE_EPOCH: ${epoch}`);
		const archiveArgs = [
			join(repoRoot, "scripts", "create-release-archive.py"),
			"--input",
			stageDirectory,
			"--output",
			archivePath,
			"--format",
			archiveExtension,
			"--epoch",
			epoch,
		];
		if (!target.startsWith("windows-")) archiveArgs.push("--root", "volt");
		run(pythonCommand, archiveArgs);
		console.log(`Built ${archivePath}`);
	} finally {
		rmSync(scratchDirectory, { recursive: true, force: true });
		if (existsSync(dirname(scratchDirectory)) && readdirSync(dirname(scratchDirectory)).length === 0) {
			rmSync(dirname(scratchDirectory), { recursive: true, force: true });
		}
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

build().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
