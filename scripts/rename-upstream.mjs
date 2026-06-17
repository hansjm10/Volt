#!/usr/bin/env node
// Rewrites upstream Pi package names to Volt package names after merging
// from upstream (earendil-works/pi-mono).
//
//   @earendil-works/pi-*  ->  @earendil-works/volt-*
//
// Intentionally left alone:
// - CHANGELOG.md files (upstream issue/PR links must keep pointing at pi-mono)
// - .volt merge guidance (must describe the upstream Pi package names)
// - package-lock.json / npm-shrinkwrap.json (regenerated, not hand-edited)
// - github.com/earendil-works/pi-mono URLs (don't match the scoped-package pattern)
//
// Usage:
//   node scripts/rename-upstream.mjs           # rewrite files in place
//   node scripts/rename-upstream.mjs --check   # report only, exit 1 if matches found

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const pattern = /@earendil-works\/pi-/g;

const extensions = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md"];
const skip = (file) =>
	file.endsWith("CHANGELOG.md") ||
	file === ".volt/skills/merge-upstream.md" ||
	file.endsWith("package-lock.json") ||
	file.endsWith("npm-shrinkwrap.json") ||
	file === "scripts/rename-upstream.mjs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
	.split("\n")
	.filter((file) => file && extensions.some((ext) => file.endsWith(ext)) && !skip(file));

const touched = [];
for (const file of files) {
	const content = readFileSync(file, "utf8");
	if (!pattern.test(content)) continue;
	pattern.lastIndex = 0;
	touched.push(file);
	if (!check) {
		writeFileSync(file, content.replace(pattern, "@earendil-works/volt-"));
	}
}

if (touched.length === 0) {
	console.log("No @earendil-works/pi-* references found.");
} else {
	console.log(`${check ? "Found" : "Rewrote"} @earendil-works/pi-* references in ${touched.length} file(s):`);
	for (const file of touched) console.log(`  ${file}`);
	if (check) process.exit(1);
}
