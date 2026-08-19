/**
 * Pure LSP WorkspaceEdit protocol normalization and text-edit planning.
 *
 * Handles both WorkspaceEdit shapes (`changes` and `documentChanges`) while
 * preserving document versions, resource options, and protocol order.
 */

import type { LspPosition, LspRange } from "./client.ts";

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

export interface CreateFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface RenameFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface DeleteFileOptions {
	recursive?: boolean;
	ignoreIfNotExists?: boolean;
}

interface TextDocumentEdit {
	textDocument: { uri: string; version: number | null };
	edits: LspTextEdit[];
}

interface CreateFileOperation {
	kind: "create";
	uri: string;
	options?: CreateFileOptions;
}

interface RenameFileOperation {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: RenameFileOptions;
}

interface DeleteFileOperation {
	kind: "delete";
	uri: string;
	options?: DeleteFileOptions;
}

type DocumentChange = TextDocumentEdit | CreateFileOperation | RenameFileOperation | DeleteFileOperation;

export interface LspWorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: DocumentChange[];
}

export type NormalizedWorkspaceOperation =
	| { kind: "edit"; uri: string; version: number | null; edits: LspTextEdit[] }
	| { kind: "create"; uri: string; options?: CreateFileOptions }
	| { kind: "rename"; oldUri: string; newUri: string; options?: RenameFileOptions }
	| { kind: "delete"; uri: string; options?: DeleteFileOptions };

function assertFileUri(uri: unknown, label: string): asserts uri is string {
	if (typeof uri !== "string") {
		throw new Error(`${label} must be a file URI`);
	}
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error(`${label} must be a valid file URI`);
	}
	if (parsed.protocol !== "file:") {
		throw new Error(`${label} must use the file URI scheme`);
	}
}

function assertPosition(position: unknown, label: string): asserts position is LspPosition {
	if (!position || typeof position !== "object") {
		throw new Error(`${label} must be an LSP position`);
	}
	const candidate = position as Partial<LspPosition>;
	if (!Number.isSafeInteger(candidate.line) || (candidate.line ?? -1) < 0) {
		throw new Error(`${label}.line must be a non-negative integer`);
	}
	if (!Number.isSafeInteger(candidate.character) || (candidate.character ?? -1) < 0) {
		throw new Error(`${label}.character must be a non-negative integer`);
	}
}

function comparePositions(left: LspPosition, right: LspPosition): number {
	return left.line - right.line || left.character - right.character;
}

function assertTextEdits(edits: unknown, label: string): asserts edits is LspTextEdit[] {
	if (!Array.isArray(edits)) {
		throw new Error(`${label} must be an array`);
	}
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index] as Partial<LspTextEdit> | null;
		if (!edit || typeof edit !== "object" || typeof edit.newText !== "string") {
			throw new Error(`${label}[${index}] must contain a string newText`);
		}
		if (!edit.range || typeof edit.range !== "object") {
			throw new Error(`${label}[${index}].range must be an LSP range`);
		}
		assertPosition(edit.range.start, `${label}[${index}].range.start`);
		assertPosition(edit.range.end, `${label}[${index}].range.end`);
		if (comparePositions(edit.range.start, edit.range.end) > 0) {
			throw new Error(`${label}[${index}] has a reversed range`);
		}
	}

	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort(
			(left, right) =>
				comparePositions(left.edit.range.start, right.edit.range.start) ||
				comparePositions(left.edit.range.end, right.edit.range.end) ||
				left.index - right.index,
		);
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1].edit.range;
		const current = sorted[index].edit.range;
		const sameEmptyPosition =
			comparePositions(previous.start, previous.end) === 0 &&
			comparePositions(current.start, current.end) === 0 &&
			comparePositions(previous.start, current.start) === 0;
		if (!sameEmptyPosition && comparePositions(current.start, previous.end) < 0) {
			throw new Error(`${label} contains overlapping edits`);
		}
	}
}

function assertOptions(options: unknown, keys: readonly string[], label: string): void {
	if (options === undefined) {
		return;
	}
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw new Error(`${label} must be an object`);
	}
	for (const key of keys) {
		const value = (options as Record<string, unknown>)[key];
		if (value !== undefined && typeof value !== "boolean") {
			throw new Error(`${label}.${key} must be a boolean`);
		}
	}
}

/** Normalize and validate a WorkspaceEdit into its ordered operation list. */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): NormalizedWorkspaceOperation[] {
	if (!edit || typeof edit !== "object") {
		throw new Error("WorkspaceEdit must be an object");
	}
	const operations: NormalizedWorkspaceOperation[] = [];
	if (edit.documentChanges !== undefined) {
		if (!Array.isArray(edit.documentChanges)) {
			throw new Error("WorkspaceEdit.documentChanges must be an array");
		}
		for (let index = 0; index < edit.documentChanges.length; index++) {
			const change = edit.documentChanges[index] as DocumentChange | null;
			const label = `WorkspaceEdit.documentChanges[${index}]`;
			if (!change || typeof change !== "object") {
				throw new Error(`${label} must be an operation`);
			}
			if ("kind" in change) {
				if (change.kind === "create") {
					assertFileUri(change.uri, `${label}.uri`);
					assertOptions(change.options, ["overwrite", "ignoreIfExists"], `${label}.options`);
					operations.push({ kind: "create", uri: change.uri, options: change.options });
				} else if (change.kind === "rename") {
					assertFileUri(change.oldUri, `${label}.oldUri`);
					assertFileUri(change.newUri, `${label}.newUri`);
					assertOptions(change.options, ["overwrite", "ignoreIfExists"], `${label}.options`);
					operations.push({
						kind: "rename",
						oldUri: change.oldUri,
						newUri: change.newUri,
						options: change.options,
					});
				} else if (change.kind === "delete") {
					assertFileUri(change.uri, `${label}.uri`);
					assertOptions(change.options, ["recursive", "ignoreIfNotExists"], `${label}.options`);
					operations.push({ kind: "delete", uri: change.uri, options: change.options });
				} else {
					throw new Error(`${label} has an unsupported resource operation`);
				}
				continue;
			}

			const textChange = change as TextDocumentEdit;
			assertFileUri(textChange.textDocument?.uri, `${label}.textDocument.uri`);
			const version = textChange.textDocument.version;
			if (version !== null && !Number.isSafeInteger(version)) {
				throw new Error(`${label}.textDocument.version must be an integer or null`);
			}
			assertTextEdits(textChange.edits, `${label}.edits`);
			operations.push({ kind: "edit", uri: textChange.textDocument.uri, version, edits: textChange.edits });
		}
		return operations;
	}

	if (
		edit.changes !== undefined &&
		(!edit.changes || typeof edit.changes !== "object" || Array.isArray(edit.changes))
	) {
		throw new Error("WorkspaceEdit.changes must be an object");
	}
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		assertFileUri(uri, "WorkspaceEdit.changes URI");
		assertTextEdits(edits, `WorkspaceEdit.changes[${JSON.stringify(uri)}]`);
		operations.push({ kind: "edit", uri, version: null, edits });
	}
	return operations;
}

interface LineBounds {
	start: number;
	end: number;
}

function getLineBounds(content: string): LineBounds[] {
	const lines: LineBounds[] = [];
	let lineStart = 0;
	for (let index = 0; index < content.length; index++) {
		const character = content[index];
		if (character !== "\n" && character !== "\r") {
			continue;
		}
		lines.push({ start: lineStart, end: index });
		if (character === "\r" && content[index + 1] === "\n") {
			index++;
		}
		lineStart = index + 1;
	}
	lines.push({ start: lineStart, end: content.length });
	return lines;
}

function positionToOffset(lines: LineBounds[], contentLength: number, position: LspPosition): number {
	if (position.line >= lines.length) {
		return contentLength;
	}
	const line = lines[position.line];
	return Math.min(line.start + position.character, line.end);
}

/** Apply validated, non-overlapping LSP TextEdits to document content. */
export function applyTextEdits(content: string, edits: LspTextEdit[]): string {
	assertTextEdits(edits, "Text edits");
	const lines = getLineBounds(content);
	const resolved = edits.map((edit, index) => ({
		start: positionToOffset(lines, content.length, edit.range.start),
		end: positionToOffset(lines, content.length, edit.range.end),
		newText: edit.newText,
		index,
	}));
	resolved.sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);

	for (let index = 1; index < resolved.length; index++) {
		const previous = resolved[index - 1];
		const current = resolved[index];
		const samePositionInserts =
			previous.start === previous.end && current.start === current.end && previous.start === current.start;
		if (!samePositionInserts && current.start < previous.end) {
			throw new Error("Text edits contain overlapping clamped ranges");
		}
	}

	let result = content;
	for (let index = resolved.length - 1; index >= 0; index--) {
		const edit = resolved[index];
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
	}
	return result;
}
