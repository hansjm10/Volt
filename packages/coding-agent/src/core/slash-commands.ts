import { APP_NAME } from "../config.ts";
import {
	CONTEXT_COMPACT_SLASH_ALIAS,
	getBuiltinHostActionSlashCommand,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_SLASH_ALIAS,
	THINKING_FAST_MODE_SLASH_ALIAS,
} from "./host-actions.ts";
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
const SESSION_RENAME_SLASH_COMMAND = getBuiltinHostActionSlashCommand(SESSION_RENAME_SLASH_ALIAS) ?? {
	name: SESSION_RENAME_SLASH_ALIAS,
	description: "Set session display name",
};
const CONTEXT_COMPACT_SLASH_COMMAND = getBuiltinHostActionSlashCommand(CONTEXT_COMPACT_SLASH_ALIAS) ?? {
	name: CONTEXT_COMPACT_SLASH_ALIAS,
	description: "Manually compact the session context",
};
const THINKING_FAST_MODE_SLASH_COMMAND = getBuiltinHostActionSlashCommand(THINKING_FAST_MODE_SLASH_ALIAS) ?? {
	name: THINKING_FAST_MODE_SLASH_ALIAS,
	description: "Toggle premium low-latency inference for the current session",
};

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "plan", description: "Switch the agent to read-only Plan mode" },
	{ name: "build", description: "Switch the agent to Build mode" },
	{ name: "plan-details", description: "Open the current structured plan" },
	{ name: "profile", description: "Show, switch, or create the active settings profile" },
	{ name: "model", description: "Select model (opens selector UI)" },
	THINKING_FAST_MODE_SLASH_COMMAND,
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	SESSION_RENAME_SLASH_COMMAND,
	{ name: "session", description: "Show session info and stats" },
	{ name: "usage", description: "Show remaining subscription quota and reset times" },
	{ name: "lsp", description: "Show LSP server status (/lsp restart, /lsp trace [path|off])" },
	{ name: "mcp", description: "Show MCP server status (/mcp connect|disconnect|refresh <server>)" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "remote", description: "Manage daemon status, phone pairing, and remote access" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "subagents", description: "Switch to the subagent conversations view" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "worktree", description: "Open a new session in a daemon-managed git worktree (/worktree new [name])" },
	{ name: "store", description: "Search, inspect, install, remove, and update extension store packages" },
	{ name: "extensions", description: "Manage installed extension packages" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	SESSION_NEW_SLASH_COMMAND,
	CONTEXT_COMPACT_SLASH_COMMAND,
	{
		name: "review",
		description: "Review code (tools, uncommitted, branch, PR, commit); findings start a fresh session",
	},
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
