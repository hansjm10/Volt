import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

export function createIgnoreMatcher(): IgnoreMatcher {
	return ignore();
}

function hasDirectorySeparator(pattern: string): boolean {
	const withoutTrailingSlash = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
	return withoutTrailingSlash.includes("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	let escapedNegation = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		escapedNegation = true;
		pattern = pattern.slice(1);
	}

	const anchored = pattern.startsWith("/");
	if (anchored) {
		pattern = pattern.slice(1);
	}

	const descendantPrefix = prefix && !anchored && !hasDirectorySeparator(pattern) ? "**/" : "";
	const prefixed = prefix ? `${prefix}${descendantPrefix}${pattern}` : pattern;
	const escaped = escapedNegation && !prefix ? `\\${prefixed}` : prefixed;
	return negated ? `!${escaped}` : escaped;
}

export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir.split(sep).join("/")}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}
