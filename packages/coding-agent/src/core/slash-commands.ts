import { APP_NAME } from "../config.ts";
import { getBuiltinHostActionSlashCommand, SESSION_NEW_SLASH_ALIAS } from "./host-actions.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

const SESSION_NEW_SLASH_COMMAND = getBuiltinHostActionSlashCommand(SESSION_NEW_SLASH_ALIAS) ?? {
	name: SESSION_NEW_SLASH_ALIAS,
	description: "Start a new session",
};

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "profile", description: "Show, switch, or create the active settings profile" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "lsp", description: "Show LSP server status (/lsp restart, /lsp trace [path|off])" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "store", description: "Search, inspect, install, remove, and update extension store packages" },
	{ name: "extensions", description: "Manage installed extension packages" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	SESSION_NEW_SLASH_COMMAND,
	{ name: "compact", description: "Manually compact the session context" },
	{
		name: "review",
		description: "Review code (tools, uncommitted, branch, PR, commit); findings start a fresh session",
	},
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
