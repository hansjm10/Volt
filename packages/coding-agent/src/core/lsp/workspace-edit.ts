/**
 * LSP WorkspaceEdit types and pure text-edit application.
 *
 * Handles both WorkspaceEdit shapes (`changes` and `documentChanges`) and
 * applies TextEdits to document content. LSP positions are UTF-16 code units,
 * which map directly onto JavaScript string indices.
 */

import type { LspPosition, LspRange } from "./client.ts";

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

interface TextDocumentEdit {
	textDocument: { uri: string };
	edits: LspTextEdit[];
}

interface CreateFileOperation {
	kind: "create";
	uri: string;
}

interface RenameFileOperation {
	kind: "rename";
	oldUri: string;
	newUri: string;
}

interface DeleteFileOperation {
	kind: "delete";
	uri: string;
}

type DocumentChange = TextDocumentEdit | CreateFileOperation | RenameFileOperation | DeleteFileOperation;

export interface LspWorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: DocumentChange[];
}

export type NormalizedWorkspaceOperation =
	| { kind: "edit"; uri: string; edits: LspTextEdit[] }
	| { kind: "create"; uri: string }
	| { kind: "rename"; oldUri: string; newUri: string }
	| { kind: "delete"; uri: string };

/**
 * Normalize a WorkspaceEdit into an ordered operation list.
 * documentChanges takes precedence over changes when both are present.
 */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): NormalizedWorkspaceOperation[] {
	const operations: NormalizedWorkspaceOperation[] = [];
	if (Array.isArray(edit.documentChanges)) {
		for (const change of edit.documentChanges) {
			if ("kind" in change) {
				if (change.kind === "create") {
					operations.push({ kind: "create", uri: change.uri });
				} else if (change.kind === "rename") {
					operations.push({ kind: "rename", oldUri: change.oldUri, newUri: change.newUri });
				} else if (change.kind === "delete") {
					operations.push({ kind: "delete", uri: change.uri });
				}
			} else if (change.textDocument?.uri && Array.isArray(change.edits)) {
				operations.push({ kind: "edit", uri: change.textDocument.uri, edits: change.edits });
			}
		}
		return operations;
	}
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		if (Array.isArray(edits)) {
			operations.push({ kind: "edit", uri, edits });
		}
	}
	return operations;
}

function positionToOffset(lineOffsets: number[], contentLength: number, position: LspPosition): number {
	if (position.line >= lineOffsets.length) {
		return contentLength;
	}
	const lineStart = lineOffsets[position.line];
	const lineEnd = position.line + 1 < lineOffsets.length ? lineOffsets[position.line + 1] : contentLength;
	return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}

/** Apply LSP TextEdits to document content. Edits must not overlap (per spec). */
export function applyTextEdits(content: string, edits: LspTextEdit[]): string {
	const lineOffsets: number[] = [0];
	for (let index = 0; index < content.length; index++) {
		if (content[index] === "\n") {
			lineOffsets.push(index + 1);
		}
	}

	const resolved = edits.map((edit) => ({
		start: positionToOffset(lineOffsets, content.length, edit.range.start),
		end: positionToOffset(lineOffsets, content.length, edit.range.end),
		newText: edit.newText,
	}));
	// Stable-sort ascending, then apply in reverse: earlier offsets stay valid
	// and same-position inserts keep their array order (per the LSP spec).
	resolved.sort((a, b) => a.start - b.start || a.end - b.end);

	let result = content;
	for (let index = resolved.length - 1; index >= 0; index--) {
		const edit = resolved[index];
		result = result.slice(0, edit.start) + edit.newText + result.slice(Math.max(edit.start, edit.end));
	}
	return result;
}
