/**
 * LSP navigation tool: definition, references, hover, symbols, and on-demand
 * diagnostics through the language servers configured in the lsp settings.
 *
 * The tool is registered as a built-in but only does useful work when an
 * LspNavigationProvider (the LspManager) is supplied, i.e. when LSP is
 * enabled via --lsp or lsp.enabled.
 */

import type { AgentTool } from "@earendil-works/volt-agent-core";
import { StringEnum } from "@earendil-works/volt-ai";
import { Text } from "@earendil-works/volt-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const LSP_ACTIONS = ["definition", "references", "hover", "symbols", "diagnostics"] as const;
export type LspAction = (typeof LSP_ACTIONS)[number];

/**
 * Navigation interface implemented by the LspManager.
 *
 * All methods return formatted, human-readable text. Failures (no server, no
 * symbol found, server errors) are reported as text rather than thrown so the
 * model can react to them.
 */
export interface LspNavigationProvider {
	definition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string>;
	references(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string>;
	hover(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<string>;
	documentSymbols(absolutePath: string, signal?: AbortSignal): Promise<string>;
	fileDiagnostics(absolutePath: string, signal?: AbortSignal): Promise<string>;
}

const lspSchema = Type.Object({
	action: StringEnum(LSP_ACTIONS, {
		description:
			"definition: where a symbol is defined. references: all usages of a symbol. hover: type/docs for a symbol. symbols: outline of a file. diagnostics: current errors in a file.",
	}),
	path: Type.String({ description: "Path to the file to query (relative or absolute)" }),
	symbol: Type.Optional(
		Type.String({
			description: "Symbol name to look up. Required for definition, references, and hover.",
		}),
	),
	line: Type.Optional(
		Type.Number({
			description:
				"1-based line number where the symbol occurrence is located. Recommended when the symbol appears multiple times in the file.",
		}),
	),
});

export type LspToolInput = Static<typeof lspSchema>;

export interface LspToolDetails {
	action: LspAction;
}

export interface LspToolOptions {
	/** Navigation provider (the LspManager). When absent, the tool reports that LSP is disabled. */
	provider?: LspNavigationProvider;
}

function formatLspCall(args: Partial<LspToolInput> | undefined, theme: Theme, cwd: string): string {
	const action = str(args?.action) ?? "";
	const path = str(args?.path);
	const line = typeof args?.line === "number" ? `:${args.line}` : "";
	const symbol = str(args?.symbol);
	let text = `${theme.fg("toolTitle", theme.bold("lsp"))} ${theme.fg("muted", action)}`;
	if (path) {
		text += ` ${renderToolPath(path, theme, cwd)}${theme.fg("muted", line)}`;
	}
	if (symbol) {
		text += ` ${theme.fg("toolOutput", symbol)}`;
	}
	return text;
}

export function createLspToolDefinition(
	cwd: string,
	options?: LspToolOptions,
): ToolDefinition<typeof lspSchema, LspToolDetails | undefined> {
	const provider = options?.provider;
	return {
		name: "lsp",
		label: "lsp",
		description:
			"Query language servers for code intelligence. Actions: definition (where a symbol is defined), references (all usages of a symbol), hover (type signature and docs), symbols (file outline), diagnostics (current errors in a file). definition/references/hover require a symbol name; pass line when the symbol occurs more than once.",
		promptSnippet: "Code intelligence via language servers: definition, references, hover, symbols, diagnostics",
		promptGuidelines: [
			"Prefer lsp references over grep when finding usages of a symbol, and lsp definition over grep when locating where a symbol is defined.",
		],
		parameters: lspSchema,
		async execute(_toolCallId, input: LspToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			if (!provider) {
				throw new Error("LSP is not enabled. Run volt with --lsp or set lsp.enabled in settings.");
			}
			const absolutePath = resolveToCwd(input.path, cwd);
			const needsSymbol = input.action === "definition" || input.action === "references" || input.action === "hover";
			if (needsSymbol && !input.symbol) {
				throw new Error(`lsp ${input.action} requires a symbol name.`);
			}

			let text: string;
			switch (input.action) {
				case "definition":
					text = await provider.definition(absolutePath, input.symbol!, input.line, signal);
					break;
				case "references":
					text = await provider.references(absolutePath, input.symbol!, input.line, signal);
					break;
				case "hover":
					text = await provider.hover(absolutePath, input.symbol!, input.line, signal);
					break;
				case "symbols":
					text = await provider.documentSymbols(absolutePath, signal);
					break;
				case "diagnostics":
					text = await provider.fileDiagnostics(absolutePath, signal);
					break;
				default:
					throw new Error(`Unknown lsp action: ${String(input.action)}`);
			}

			return {
				content: [{ type: "text", text }],
				details: { action: input.action },
			};
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatLspCall(args as Partial<LspToolInput> | undefined, theme, context.cwd));
			return component;
		},
	};
}

export function createLspTool(cwd: string, options?: LspToolOptions): AgentTool<typeof lspSchema> {
	return wrapToolDefinition(createLspToolDefinition(cwd, options));
}
