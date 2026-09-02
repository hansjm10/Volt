import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectionSanitizer } from "../../rpc/stream-projection.ts";

export const IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH = "[redacted bash output path]";
export const IROH_REMOTE_REDACTED_EXPORT_PATH = "[redacted export path]";
export const IROH_REMOTE_REDACTED_SESSION_FILE = "[redacted session file]";

const OMIT_REMOTE_PATH_FIELDS = new Set([
	"childSessionRef",
	"fullOutputPath",
	"parentSession",
	"parentSessionRef",
	"previousSessionRef",
	"sessionDirectory",
	"sessionFile",
	"sessionRef",
	"targetSessionRef",
]);
const STRICT_REMOTE_PATH_FIELDS = new Set([
	"cwd",
	"exportPath",
	"extensionPath",
	"filePath",
	"outputPath",
	"parentSession",
	"path",
	"sessionPath",
	"traceFile",
]);

export interface IrohRemoteSanitizerOptions {
	remoteWorkspacePath?: string;
	workspacePath: string;
	/** Extra roots (e.g. a worktree's parent checkout) redacted to remoteWorkspacePath. */
	additionalRedactedPaths?: string[];
}

export type IrohRemoteSanitizerValuePreserver = (
	record: Readonly<Record<string, unknown>>,
	key: string,
	value: unknown,
) => boolean;

export interface IrohRemoteProjectionSanitizer extends ProjectionSanitizer {
	sanitizeValue(value: unknown, preserveEntry?: IrohRemoteSanitizerValuePreserver): unknown;
}

interface IrohRemoteOutboundSanitizerContext {
	remoteWorkspacePath: string;
	workspacePath: string;
	workspacePathPatterns: string[];
}

type PathContinuationMode = "text" | "delimited";

/**
 * Creates the shared field-aware sanitizer used by Iroh stream projection and
 * whole-frame outbound filtering.
 */
export function createIrohRemoteProjectionSanitizer(
	options: IrohRemoteSanitizerOptions,
): IrohRemoteProjectionSanitizer {
	const context = createSanitizerContext(options);
	return {
		sanitizeText: (value) => sanitizeRemoteText(value, context),
		sanitizeValue: (value, preserveEntry) => sanitizeValue(value, context, undefined, preserveEntry),
	};
}

function createSanitizerContext(options: IrohRemoteSanitizerOptions): IrohRemoteOutboundSanitizerContext {
	const resolvedWorkspacePath = resolve(options.workspacePath);
	// Compare and redact in a Unicode-normalization-insensitive way: macOS surfaces
	// on-disk paths in NFD while a configured root may be NFC (or vice versa), and a
	// byte-exact compare would let a differently-composed form of an in-workspace path
	// bypass redaction and leak the real host path. Canonicalize the compared root to
	// NFC, and match embedded occurrences against both NFC and NFD forms.
	const workspacePath = resolvedWorkspacePath.normalize("NFC");
	// Additional roots (worktree parent checkout, worktrees root) fold into the
	// same pattern list: every occurrence maps to remoteWorkspacePath. On Windows,
	// match either separator so mixed paths cannot bypass redaction.
	const redactedRoots = [
		resolvedWorkspacePath,
		...(options.additionalRedactedPaths ?? []).map((value) => resolve(value)),
	];
	const workspacePathPatterns = [
		...new Set(redactedRoots.flatMap((root) => [root.normalize("NFC"), root.normalize("NFD")])),
	]
		.filter((value) => value.length > 0)
		.sort((left, right) => right.length - left.length)
		.map(createWorkspacePathPattern);
	return {
		remoteWorkspacePath: options.remoteWorkspacePath ?? "/workspace",
		workspacePath,
		workspacePathPatterns,
	};
}

function sanitizeValue(
	value: unknown,
	context: IrohRemoteOutboundSanitizerContext,
	fieldName: string | undefined,
	preserveEntry?: IrohRemoteSanitizerValuePreserver,
): unknown {
	if (typeof value === "string") {
		return shouldTreatAsPathField(fieldName) ? sanitizePathField(value, context) : sanitizeRemoteText(value, context);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeValue(entry, context, fieldName, preserveEntry));
	}
	if (!isRecord(value)) {
		return value;
	}

	const sanitized: Record<string, unknown> = Object.create(null);
	for (const [key, entry] of Object.entries(value)) {
		if (OMIT_REMOTE_PATH_FIELDS.has(key)) {
			continue;
		}
		const sanitizedEntry =
			preserveEntry?.(value, key, entry) === true || shouldPreserveOpaqueStringEntry(value, key, entry)
				? entry
				: sanitizeValue(entry, context, key, preserveEntry);
		if (sanitizedEntry !== undefined) {
			setSanitizedObjectEntry(sanitized, sanitizeObjectKey(key, context), sanitizedEntry);
		}
	}
	return sanitized;
}

function shouldPreserveOpaqueStringEntry(
	record: Record<string, unknown>,
	key: string,
	value: unknown,
): value is string {
	if (typeof value !== "string") {
		return false;
	}
	return (
		key === "id" ||
		(key === "data" && isImageContentRecord(record)) ||
		(key === "textSignature" && isTypedContentRecord(record, "text")) ||
		(key === "thinkingSignature" && isTypedContentRecord(record, "thinking")) ||
		(key === "thoughtSignature" && isTypedContentRecord(record, "toolCall"))
	);
}

function isImageContentRecord(record: Record<string, unknown>): boolean {
	return record.type === "image" && typeof record.mimeType === "string" && record.mimeType.startsWith("image/");
}

function isTypedContentRecord(record: Record<string, unknown>, type: string): boolean {
	return record.type === type;
}

function shouldTreatAsPathField(fieldName: string | undefined): boolean {
	if (!fieldName) {
		return false;
	}
	if (STRICT_REMOTE_PATH_FIELDS.has(fieldName)) {
		return true;
	}
	return fieldName.endsWith("Dir") || fieldName.endsWith("File") || fieldName.endsWith("Path");
}

function sanitizePathField(value: string, context: IrohRemoteOutboundSanitizerContext): string {
	if (hasPathListSeparator(value)) {
		return redactPathOccurrences(value, context, "text");
	}
	const normalized = normalizeWorkspacePath(value, context);
	if (normalized) {
		return normalized;
	}
	if (isRemoteWorkspacePath(value, context)) {
		return value;
	}
	if (isBashOutputPath(value)) {
		return IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH;
	}
	if (isSessionFilePath(value)) {
		return IROH_REMOTE_REDACTED_SESSION_FILE;
	}
	if (isExportPath(value)) {
		return IROH_REMOTE_REDACTED_EXPORT_PATH;
	}
	if (isTildePath(value)) {
		return sanitizePathToken(value, context);
	}
	const redactedValue = normalizeWorkspacePathOccurrences(value, context);
	if (redactedValue !== value) {
		return redactedValue;
	}
	if (isAbsolute(value) || isWindowsAbsolutePath(value) || isWindowsUncPath(value) || isFileUrl(value)) {
		return value;
	}
	return sanitizeRemoteText(value, context);
}

function sanitizeRemoteText(value: string, context: IrohRemoteOutboundSanitizerContext): string {
	return sanitizePathOccurrences(value, context, "text");
}

function sanitizeObjectKey(value: string, context: IrohRemoteOutboundSanitizerContext): string {
	return redactPathOccurrences(value, context, "delimited");
}

function setSanitizedObjectEntry(target: Record<string, unknown>, key: string, value: unknown): void {
	target[getUniqueObjectKey(target, key)] = value;
}

function getUniqueObjectKey(target: Record<string, unknown>, key: string): string {
	if (!hasOwnEntry(target, key)) {
		return key;
	}
	let index = 2;
	while (hasOwnEntry(target, `${key} (${index})`)) {
		index++;
	}
	return `${key} (${index})`;
}

function hasOwnEntry(value: object, key: string): boolean {
	return Object.hasOwn(value, key);
}

function normalizeWorkspacePath(value: string, context: IrohRemoteOutboundSanitizerContext): string | undefined {
	if (!isAbsolute(value)) {
		return undefined;
	}
	const candidatePath = resolve(value).normalize("NFC");
	const relativePath = relative(context.workspacePath, candidatePath);
	if (relativePath === "") {
		return context.remoteWorkspacePath;
	}
	if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
		return undefined;
	}
	return `${context.remoteWorkspacePath}/${toPosixPath(relativePath)}`;
}

function normalizeWorkspacePathOccurrences(value: string, context: IrohRemoteOutboundSanitizerContext): string {
	let normalized = value;
	let redacted = false;
	for (const workspacePathPattern of context.workspacePathPatterns) {
		const next = normalized.replace(
			new RegExp(`${workspacePathPattern}(?=$|[\\\\/\\s"'<>),.;:!?}\\]])`, sep === "\\" ? "gi" : "g"),
			context.remoteWorkspacePath,
		);
		redacted ||= next !== normalized;
		normalized = next;
	}
	return redacted && sep === "\\" ? normalized.replaceAll("\\", "/") : normalized;
}

function redactPathOccurrences(
	value: string,
	context: IrohRemoteOutboundSanitizerContext,
	mode: PathContinuationMode,
): string {
	return sanitizePathOccurrences(value, context, mode);
}

function sanitizePathOccurrences(
	value: string,
	context: IrohRemoteOutboundSanitizerContext,
	mode: PathContinuationMode,
): string {
	let sanitized = "";
	let index = 0;
	while (index < value.length) {
		if (
			startsFileUrlAt(value, index) ||
			startsTildePathAt(value, index) ||
			startsWindowsPathAt(value, index) ||
			startsEscapedWindowsUncPathAt(value, index) ||
			startsWindowsUncPathAt(value, index) ||
			startsPosixPathAt(value, index)
		) {
			const tokenMode = mode === "delimited" || isDelimitedPathToken(value, index) ? "delimited" : "text";
			const tokenEnd = findPathTokenEnd(value, index, context, tokenMode);
			sanitized += sanitizePathToken(value.slice(index, tokenEnd), context);
			index = tokenEnd;
			continue;
		}
		sanitized += value[index];
		index++;
	}
	return sanitized;
}

function sanitizePathToken(value: string, context: IrohRemoteOutboundSanitizerContext): string {
	const { path, suffix } = splitTrailingPathPunctuation(value);
	if (path === "/") {
		return `${path}${suffix}`;
	}
	const normalizedPath = normalizeWorkspacePath(path, context);
	if (normalizedPath) {
		return `${normalizedPath}${suffix}`;
	}
	if (isRemoteWorkspacePath(path, context)) {
		return `${path}${suffix}`;
	}
	if (isBashOutputPath(path)) {
		return `${IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH}${suffix}`;
	}
	if (isSessionFilePath(path)) {
		return `${IROH_REMOTE_REDACTED_SESSION_FILE}${suffix}`;
	}
	if (isExportPath(path)) {
		return `${IROH_REMOTE_REDACTED_EXPORT_PATH}${suffix}`;
	}
	if (
		isAbsolute(path) ||
		isTildePath(path) ||
		isWindowsAbsolutePath(path) ||
		isEscapedWindowsUncPath(path) ||
		isWindowsUncPath(path) ||
		isFileUrl(path)
	) {
		// The path is outside the workspace (or unresolvable as a subpath), but it may
		// still embed the workspace root glued to a non-separator delimiter (e.g.
		// "<workspace>:extra"), which normalizeWorkspacePath treats as a sibling and
		// would otherwise leak the real host path verbatim. Redact any embedded
		// workspace-path prefix before returning.
		return `${normalizeWorkspacePathOccurrences(path, context)}${suffix}`;
	}
	return `${normalizeWorkspacePathOccurrences(path, context)}${suffix}`;
}

function splitTrailingPathPunctuation(value: string): { path: string; suffix: string } {
	const match = value.match(/[),.;:!?}\]]+$/);
	if (!match) {
		return { path: value, suffix: "" };
	}
	const suffix = match[0];
	return { path: value.slice(0, -suffix.length), suffix };
}

function isRemoteWorkspacePath(value: string, context: IrohRemoteOutboundSanitizerContext): boolean {
	return value === context.remoteWorkspacePath || value.startsWith(`${context.remoteWorkspacePath}/`);
}

function isBashOutputPath(value: string): boolean {
	return /(?:^|[/\\])volt-bash-[A-Za-z0-9_-]+\.log$/.test(value);
}

function isSessionFilePath(value: string): boolean {
	return /[/\\]sessions[/\\].+\.jsonl$/.test(value);
}

function isExportPath(value: string): boolean {
	return /(?:^|[/\\])Volt-session-[^/\\]+\.html$/.test(value);
}

function startsFileUrlAt(value: string, index: number): boolean {
	if (!isPathPrefixBoundary(value, index)) {
		return false;
	}
	return value.slice(index, index + "file://".length).toLowerCase() === "file://";
}

function startsTildePathAt(value: string, index: number): boolean {
	if (!isPathPrefixBoundary(value, index)) {
		return false;
	}
	return isTildePath(value.slice(index));
}

function startsWindowsPathAt(value: string, index: number): boolean {
	if (!isPathPrefixBoundary(value, index)) {
		return false;
	}
	return /^[A-Za-z]:[\\/]/.test(value.slice(index));
}

function startsWindowsUncPathAt(value: string, index: number): boolean {
	if (!isPathPrefixBoundary(value, index)) {
		return false;
	}
	return isWindowsUncPath(value.slice(index));
}

function startsEscapedWindowsUncPathAt(value: string, index: number): boolean {
	if (!isPathPrefixBoundary(value, index)) {
		return false;
	}
	return isEscapedWindowsUncPath(value.slice(index));
}

function startsPosixPathAt(value: string, index: number): boolean {
	if (value[index] !== "/" || !isPathPrefixBoundary(value, index)) {
		return false;
	}
	if (value[index - 1] === ":" && value[index + 1] === "/") {
		return false;
	}
	if (isRelativePathSeparatorAt(value, index)) {
		return false;
	}
	return !isInsideUrlToken(value, index);
}

function isRelativePathSeparatorAt(value: string, index: number): boolean {
	const previousIndex = findPreviousNonWhitespaceIndex(value, index - 1);
	const nextIndex = findNextNonWhitespaceIndex(value, index + 1);
	if (previousIndex === undefined || nextIndex === undefined) {
		return false;
	}
	if (!isRelativePathSegmentCharacter(value[previousIndex]) || !isRelativePathSegmentCharacter(value[nextIndex])) {
		return false;
	}
	const segmentEnd = findPathSegmentEnd(value, nextIndex);
	const nextSegment = stripTrailingPathPunctuation(value.slice(nextIndex, segmentEnd));
	if (hasPathSeparator(nextSegment)) {
		return false;
	}
	const previousSegmentStart = findPathTokenStart(value, previousIndex + 1);
	const previousSegment = value.slice(previousSegmentStart, previousIndex + 1);
	return isPlainRelativePathSegment(previousSegment) && looksLikeRelativeFileNameSegment(nextSegment);
}

function isPathPrefixBoundary(value: string, index: number): boolean {
	if (index === 0) {
		return true;
	}
	const prefix = value[index - 1];
	return /\s/.test(prefix) || "\"'`([{<>=,:;|".includes(prefix);
}

function isDelimitedPathToken(value: string, index: number): boolean {
	if (index === 0) {
		return false;
	}
	return "\"'`|".includes(value[index - 1]);
}

function isInsideUrlToken(value: string, index: number): boolean {
	const tokenStart = findPathTokenStart(value, index);
	const prefix = value.slice(tokenStart, index);
	return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*$/.test(prefix);
}

function findPathTokenStart(value: string, index: number): number {
	let tokenStart = index;
	while (tokenStart > 0 && !isPathTokenStartDelimiter(value[tokenStart - 1])) {
		tokenStart--;
	}
	return tokenStart;
}

function findPreviousNonWhitespaceIndex(value: string, index: number): number | undefined {
	for (let cursor = index; cursor >= 0; cursor--) {
		if (!isPathTokenWhitespace(value[cursor])) {
			return cursor;
		}
	}
	return undefined;
}

function findNextNonWhitespaceIndex(value: string, index: number): number | undefined {
	for (let cursor = index; cursor < value.length; cursor++) {
		if (!isPathTokenWhitespace(value[cursor])) {
			return cursor;
		}
	}
	return undefined;
}

function findPathTokenEnd(
	value: string,
	index: number,
	context: IrohRemoteOutboundSanitizerContext,
	mode: PathContinuationMode,
): number {
	let tokenEnd = index;
	while (tokenEnd < value.length && !isPathTokenDelimiter(value, tokenEnd)) {
		if (isPathTokenWhitespace(value[tokenEnd])) {
			const continuation = findPathContinuation(value, index, tokenEnd, context, mode);
			if (continuation === undefined) {
				break;
			}
			tokenEnd = continuation.end;
			if (!continuation.canContinue) {
				break;
			}
			continue;
		}
		tokenEnd++;
	}
	return tokenEnd;
}

function findPathContinuation(
	value: string,
	tokenStart: number,
	whitespaceStart: number,
	context: IrohRemoteOutboundSanitizerContext,
	mode: PathContinuationMode,
): { canContinue: boolean; end: number } | undefined {
	let continuationStart = whitespaceStart;
	while (continuationStart < value.length && isPathTokenWhitespace(value[continuationStart])) {
		continuationStart++;
	}
	if (continuationStart === whitespaceStart || continuationStart >= value.length) {
		return undefined;
	}
	if (
		startsFileUrlAt(value, continuationStart) ||
		startsTildePathAt(value, continuationStart) ||
		startsWindowsPathAt(value, continuationStart) ||
		startsEscapedWindowsUncPathAt(value, continuationStart) ||
		startsWindowsUncPathAt(value, continuationStart) ||
		startsPosixPathAt(value, continuationStart)
	) {
		return undefined;
	}
	const prefix = value.slice(tokenStart, whitespaceStart);
	if (endsWithPathTokenPunctuation(prefix)) {
		return undefined;
	}
	const segmentEnd = findPathSegmentEnd(value, continuationStart);
	const segment = value.slice(continuationStart, segmentEnd);
	if (startsColonAdjacentPathSegment(segment)) {
		return undefined;
	}
	if (segment.includes("://")) {
		return undefined;
	}
	if (hasPathSeparator(segment)) {
		if (!shouldContinuePathAcrossWhitespace(prefix, segment, context)) {
			return undefined;
		}
		return { canContinue: true, end: segmentEnd };
	}
	if (!shouldConsumePlainPathContinuation(prefix, segment, context, mode)) {
		return undefined;
	}
	return { canContinue: true, end: segmentEnd };
}

function findPathSegmentEnd(value: string, index: number): number {
	let segmentEnd = index;
	while (segmentEnd < value.length && !isPathSegmentDelimiter(value, segmentEnd)) {
		segmentEnd++;
	}
	return segmentEnd;
}

function shouldConsumePlainPathContinuation(
	prefix: string,
	segment: string,
	context: IrohRemoteOutboundSanitizerContext,
	mode: PathContinuationMode,
): boolean {
	const combined = `${prefix} ${stripTrailingPathPunctuation(segment)}`;
	const baseAllowed =
		normalizeWorkspacePath(prefix, context) === undefined &&
		normalizeWorkspacePath(combined, context) === undefined &&
		looksLikeIncompletePathName(prefix) &&
		looksLikePlainPathNameSegment(segment) &&
		!isProsePathContinuationWord(stripTrailingPathPunctuation(segment));
	if (!baseAllowed) {
		return false;
	}
	if (looksLikeUserHomePath(prefix)) {
		return true;
	}
	return (
		mode === "delimited" ||
		hasPathTokenWhitespace(prefix) ||
		isCommonPathNameSegment(segment) ||
		looksLikeCapitalizedPathNameSegment(segment)
	);
}

function shouldContinuePathAcrossWhitespace(
	prefix: string,
	segment: string,
	context: IrohRemoteOutboundSanitizerContext,
): boolean {
	return (
		normalizeWorkspacePath(prefix, context) === undefined &&
		looksLikeIncompletePathName(prefix) &&
		looksLikePathContinuationSegment(segment)
	);
}

function looksLikeIncompletePathName(value: string): boolean {
	const lastSegment = getLastPathSegment(value);
	return (
		(isAbsolute(value) ||
			isTildePath(value) ||
			isWindowsAbsolutePath(value) ||
			isWindowsUncPath(value) ||
			isFileUrl(value)) &&
		lastSegment.length > 0 &&
		!lastSegment.includes(".")
	);
}

function looksLikePlainPathNameSegment(value: string): boolean {
	const trimmed = stripTrailingPathPunctuation(value);
	return /^[A-Za-z0-9._-]/.test(trimmed);
}

function isRelativePathSegmentCharacter(value: string | undefined): boolean {
	return value !== undefined && /[A-Za-z0-9._-]/.test(value);
}

function isPlainRelativePathSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function looksLikeRelativeFileNameSegment(value: string): boolean {
	return isPlainRelativePathSegment(value) && /(?:^\.|.+\.[A-Za-z0-9]+$)/.test(value);
}

function looksLikeCapitalizedPathNameSegment(value: string): boolean {
	const trimmed = stripTrailingPathPunctuation(value);
	return /^[A-Z][A-Za-z0-9._-]*$/.test(trimmed);
}

function looksLikePathContinuationSegment(value: string): boolean {
	const trimmed = stripTrailingPathPunctuation(value);
	if (/^and[/\\]or$/i.test(trimmed)) {
		return false;
	}
	const parts = trimmed.split(/[\\/]+/).filter((part) => part.length > 0);
	if (parts[0] && isProsePathContinuationWord(parts[0])) {
		return false;
	}
	return parts.length >= 2;
}

function hasPathSeparator(value: string): boolean {
	return value.includes("/") || value.includes("\\");
}

function isProsePathContinuationWord(value: string): boolean {
	const normalized = value.toLowerCase();
	return (
		normalized === "and" ||
		normalized === "badly" ||
		normalized === "crashed" ||
		normalized === "done" ||
		normalized === "exists" ||
		normalized === "failed" ||
		normalized === "found" ||
		normalized === "missing" ||
		normalized === "not" ||
		normalized === "or" ||
		normalized === "suffix"
	);
}

function isCommonPathNameSegment(value: string): boolean {
	const normalized = stripTrailingPathPunctuation(value).toLowerCase();
	return (
		normalized === "app" ||
		normalized === "build" ||
		normalized === "cache" ||
		normalized === "config" ||
		normalized === "data" ||
		normalized === "dist" ||
		normalized === "log" ||
		normalized === "logs" ||
		normalized === "project" ||
		normalized === "temp" ||
		normalized === "tmp"
	);
}

function startsColonAdjacentPathSegment(value: string): boolean {
	return /^[^/\\\s]+:[/\\]/.test(value);
}

function getLastPathSegment(value: string): string {
	const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	return separatorIndex === -1 ? value : value.slice(separatorIndex + 1);
}

function looksLikeUserHomePath(value: string): boolean {
	return /^\/Users\/[^/]+$/.test(value) || /^[A-Za-z]:[\\/]Users[\\/][^\\/]+$/.test(value);
}

function endsWithPathTokenPunctuation(value: string): boolean {
	return /[),.;:!?}\]]$/.test(value);
}

function stripTrailingPathPunctuation(value: string): string {
	return value.replace(/[),.;:!?}\]]+$/, "");
}

function isPathTokenDelimiter(value: string, index: number): boolean {
	const character = value[index];
	return (
		character === "\n" ||
		character === "\r" ||
		character === '"' ||
		character === "`" ||
		character === "<" ||
		character === ">" ||
		character === "|" ||
		isEscapedPathQuote(value, index) ||
		isPathListSeparator(value, index) ||
		(character === "'" && isLikelyClosingSingleQuote(value, index))
	);
}

function isPathTokenStartDelimiter(value: string): boolean {
	return /\s/.test(value) || "\"'<>|".includes(value);
}

function isPathSegmentDelimiter(value: string, index: number): boolean {
	return isPathTokenWhitespace(value[index]) || isPathTokenDelimiter(value, index);
}

function isPathTokenWhitespace(value: string): boolean {
	return value === " " || value === "\t";
}

function hasPathTokenWhitespace(value: string): boolean {
	return value.includes(" ") || value.includes("\t");
}

function hasPathListSeparator(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if (isPathListSeparator(value, index)) {
			return true;
		}
	}
	return false;
}

function isEscapedPathQuote(value: string, index: number): boolean {
	return value[index] === "\\" && value[index + 1] === '"';
}

function isPathListSeparator(value: string, index: number): boolean {
	if (!":;,".includes(value[index])) {
		return false;
	}
	if (value[index] === ":" && index > 0 && startsWindowsPathAt(value, index - 1)) {
		return false;
	}
	const pathStart = index + 1;
	return (
		startsFileUrlAt(value, pathStart) ||
		startsTildePathAt(value, pathStart) ||
		startsWindowsPathAt(value, pathStart) ||
		startsEscapedWindowsUncPathAt(value, pathStart) ||
		startsWindowsUncPathAt(value, pathStart) ||
		startsPosixPathAt(value, pathStart)
	);
}

function isLikelyClosingSingleQuote(value: string, index: number): boolean {
	const previous = value[index - 1];
	const next = value[index + 1];
	if (next === undefined || '"`<>),.;:!?}]'.includes(next)) {
		return true;
	}
	if (previous !== undefined && /[A-Za-z0-9]/.test(previous)) {
		const tokenStart = findPathTokenStart(value, index);
		return !looksLikeIncompletePathName(value.slice(tokenStart, index));
	}
	if (!/\s/.test(next)) {
		return false;
	}
	return true;
}

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function createWorkspacePathPattern(value: string): string {
	const separatorPattern = sep === "\\" ? "[\\\\/]" : "/";
	return value.split(sep).map(escapeRegExp).join(separatorPattern);
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

function isWindowsUncPath(value: string): boolean {
	return /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isEscapedWindowsUncPath(value: string): boolean {
	return /^\\\\\\\\[^\\]+\\\\[^\\]+/.test(value);
}

function isTildePath(value: string): boolean {
	return /^~[^/\\\s]*(?:$|[\\/])/.test(value);
}

function isFileUrl(value: string): boolean {
	return value.slice(0, "file://".length).toLowerCase() === "file://";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
