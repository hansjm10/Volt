#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const tsconfigPath = join(repoRoot, "tsconfig.json");

process.argv[1] = cliPath;

const jiti = createJiti(cliPath, {
	tsconfigPaths: tsconfigPath,
});

await jiti.import(cliPath);
