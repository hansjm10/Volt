#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentRoot = join(repoRoot, "packages", "coding-agent");
const outputDirectory = join(codingAgentRoot, "dist", "core", "npm");
const cliOutputPath = join(outputDirectory, "cli.js");
const allowedExternalPackages = [
	"@hansjm10/volt-tui",
	"@hansjm10/volt-tui/*",
	"@hansjm10/volt-iroh",
	"@hansjm10/volt-iroh/*",
	"bufferutil",
	"supports-color",
	"utf-8-validate",
];

function assertRequiredFile(path) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`Required npm CLI bundle input is missing: ${path}`);
	}
}

function externalPackageAllowed(path) {
	return allowedExternalPackages.some((allowed) =>
		allowed.endsWith("/*") ? path.startsWith(allowed.slice(0, -1)) : path === allowed,
	);
}

function assertBundleMetafile(metafile) {
	const nativeInputs = Object.keys(metafile.inputs ?? {}).filter((path) => /\.(?:node|wasm)(?:$|\?)/.test(path));
	if (nativeInputs.length > 0) {
		throw new Error(`npm CLI JavaScript bundles contain native/WASM inputs:\n${nativeInputs.sort().join("\n")}`);
	}

	const unexpected = new Set();
	for (const output of Object.values(metafile.outputs ?? {})) {
		for (const externalImport of output.imports ?? []) {
			if (!externalImport.external || isBuiltin(externalImport.path) || externalPackageAllowed(externalImport.path)) {
				continue;
			}
			unexpected.add(externalImport.path);
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Unexpected external imports in npm CLI bundle:\n${[...unexpected].sort().join("\n")}`);
	}

	const bundledIroh = Object.keys(metafile.inputs ?? {}).filter((path) =>
		path.replaceAll("\\", "/").includes("node_modules/@hansjm10/volt-iroh/"),
	);
	if (bundledIroh.length > 0) {
		throw new Error(`The npm CLI bundle embedded @hansjm10/volt-iroh:\n${bundledIroh.join("\n")}`);
	}
}

function smokeTestCli() {
	const packageJson = JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8"));
	const result = spawnSync(process.execPath, [cliOutputPath, "--version"], {
		cwd: codingAgentRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Bundled npm CLI smoke test failed with exit code ${result.status}: ${result.stderr || result.stdout}`);
	}
	if (result.stdout.trim() !== packageJson.version) {
		throw new Error(`Bundled npm CLI reported version ${result.stdout.trim()}, expected ${packageJson.version}`);
	}
}

async function build() {
	const entryPoints = [
		{ in: join(codingAgentRoot, "dist", "cli.js"), out: "cli" },
		{ in: join(codingAgentRoot, "dist", "utils", "image-resize-worker.js"), out: "image-resize-worker" },
		{ in: join(repoRoot, "packages", "ai", "dist", "providers", "amazon-bedrock.js"), out: "amazon-bedrock" },
	];
	for (const entryPoint of entryPoints) assertRequiredFile(entryPoint.in);

	rmSync(outputDirectory, { recursive: true, force: true });
	mkdirSync(outputDirectory, { recursive: true });
	const result = await esbuild.build({
		absWorkingDir: repoRoot,
		entryPoints,
		outdir: outputDirectory,
		entryNames: "[name]",
		chunkNames: "chunk-[name]-[hash]",
		bundle: true,
		splitting: true,
		platform: "node",
		format: "esm",
		target: "node26",
		tsconfigRaw: { compilerOptions: {} },
		metafile: true,
		logLevel: "info",
		legalComments: "none",
		banner: {
			js: 'import { createRequire as __voltCreateRequire } from "node:module"; const require = __voltCreateRequire(import.meta.url);',
		},
		define: {
			__VOLT_BUNDLED_CLI__: "true",
			__VOLT_STANDALONE__: "false",
		},
		external: allowedExternalPackages,
	});
	assertBundleMetafile(result.metafile);
	assertRequiredFile(cliOutputPath);
	chmodSync(cliOutputPath, 0o755);
	smokeTestCli();
}

build().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
