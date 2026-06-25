/**
 * LSP configuration: settings types, built-in server defaults, and resolution.
 *
 * Server definitions are config-driven. Users add or override servers via the
 * `lsp.servers` settings block; built-in defaults cover common languages and
 * are only used when the matching server binary is installed.
 */

import { basename } from "node:path";

export type LspSeverity = "error" | "warning" | "information" | "hint";

/** One language server definition. User entries merge over built-in defaults by name. */
export interface LspServerSettings {
	/** Server launch command, argv-style (e.g. ["typescript-language-server", "--stdio"]) */
	command?: string[];
	/** File extensions routed to this server (e.g. [".ts", ".tsx"]) */
	fileExtensions?: string[];
	/** Files or directories whose presence marks a project root (searched upward from the edited file) */
	rootMarkers?: string[];
	/** LSP initializationOptions passed during the initialize handshake */
	initializationOptions?: unknown;
	/**
	 * Server configuration, sent via workspace/didChangeConfiguration after
	 * startup and used to answer workspace/configuration requests (section
	 * lookups use dot-separated paths into this object).
	 */
	settings?: unknown;
	/** Set false to disable a built-in or configured server */
	enabled?: boolean;
}

export interface LspSettings {
	/** Enable LSP diagnostics after edit/write. Default: true (set false to disable; --lsp forces enabled per run) */
	enabled?: boolean;
	/** Server definitions, merged over the built-in defaults by name */
	servers?: Record<string, LspServerSettings>;
	/** How long to wait for published diagnostics after a change, in milliseconds. Default: 1500 */
	settleMs?: number;
	/**
	 * How long to wait for the first diagnostics from a freshly started server,
	 * in milliseconds. Servers like tsserver publish nothing until the project
	 * has loaded, so the first collection gets a longer window. Default: 10000
	 */
	firstSettleMs?: number;
	/** Maximum diagnostics reported per tool call. Default: 20 */
	maxDiagnostics?: number;
	/** Shut down language servers idle for this long, in milliseconds. 0 disables. Default: 600000 (10 minutes) */
	idleShutdownMs?: number;
	/** Append LSP protocol traffic, server stderr, and lifecycle events to this file (also /lsp trace at runtime) */
	traceFile?: string;
	/** Minimum severity to report. Default: "error" */
	severity?: LspSeverity;
}

export interface ResolvedLspServerConfig {
	name: string;
	command: string[];
	fileExtensions: string[];
	rootMarkers: string[];
	initializationOptions?: unknown;
	settings?: unknown;
	/** Trusted automatic install recipe, present only for matching built-in server defaults. */
	installRecipe?: LspInstallRecipe;
	/** Manual install guidance for recognized server binaries. */
	installHint?: string;
}

export interface LspInstallRecipe {
	binary: string;
	command: string[];
	displayCommand: string;
	installHint: string;
}

export interface ResolvedLspConfig {
	enabled: boolean;
	servers: ResolvedLspServerConfig[];
	settleMs: number;
	firstSettleMs: number;
	maxDiagnostics: number;
	idleShutdownMs: number;
	traceFile?: string;
	/** Numeric LSP DiagnosticSeverity cutoff (1=error .. 4=hint); diagnostics with severity <= this value are reported */
	maxSeverity: number;
}

const DEFAULT_LSP_SERVERS: Record<
	string,
	Required<Pick<LspServerSettings, "command" | "fileExtensions" | "rootMarkers">>
> = {
	typescript: {
		command: ["typescript-language-server", "--stdio"],
		fileExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	},
	python: {
		command: ["pyright-langserver", "--stdio"],
		fileExtensions: [".py", ".pyi"],
		rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"],
	},
	go: {
		command: ["gopls"],
		fileExtensions: [".go"],
		rootMarkers: ["go.mod", "go.work"],
	},
	rust: {
		command: ["rust-analyzer"],
		fileExtensions: [".rs"],
		rootMarkers: ["Cargo.toml"],
	},
	cpp: {
		command: ["clangd"],
		fileExtensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
	},
	zig: {
		command: ["zls"],
		fileExtensions: [".zig"],
		rootMarkers: ["build.zig"],
	},
	lua: {
		command: ["lua-language-server"],
		fileExtensions: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc"],
	},
	bash: {
		command: ["bash-language-server", "start"],
		fileExtensions: [".sh", ".bash"],
		rootMarkers: [],
	},
};

/**
 * Trusted install recipes keyed by server binary (argv[0]). These are host-owned
 * commands for built-in server binaries. Resolution attaches them only to
 * matching built-in server entries, not arbitrary custom server definitions.
 */
const INSTALL_RECIPES: Record<string, Omit<LspInstallRecipe, "binary">> = {
	"typescript-language-server": {
		command: ["npm", "install", "-g", "typescript-language-server", "typescript"],
		displayCommand: "npm install -g typescript-language-server typescript",
		installHint: "Install with: npm install -g typescript-language-server typescript",
	},
	"pyright-langserver": {
		command: ["npm", "install", "-g", "pyright"],
		displayCommand: "npm install -g pyright",
		installHint: "Install with: npm install -g pyright",
	},
	gopls: {
		command: ["go", "install", "golang.org/x/tools/gopls@latest"],
		displayCommand: "go install golang.org/x/tools/gopls@latest",
		installHint: "Install with: go install golang.org/x/tools/gopls@latest",
	},
	"rust-analyzer": {
		command: ["rustup", "component", "add", "rust-analyzer"],
		displayCommand: "rustup component add rust-analyzer",
		installHint: "Install with: rustup component add rust-analyzer",
	},
	"bash-language-server": {
		command: ["npm", "install", "-g", "bash-language-server"],
		displayCommand: "npm install -g bash-language-server",
		installHint: "Install with: npm install -g bash-language-server",
	},
};

const MANUAL_INSTALL_HINTS: Record<string, string> = {
	clangd: "Install instructions: https://clangd.llvm.org/installation",
	zls: "Install instructions: https://github.com/zigtools/zls",
	"lua-language-server": "Install instructions: https://luals.github.io/#install",
};

/**
 * Trusted install recipe for a server launch command, or undefined for unknown
 * or manual-install-only binaries. Matches on the binary basename so absolute
 * path commands (e.g. /usr/local/bin/gopls) still get the reviewed recipe for
 * that binary.
 */
export function installRecipeForCommand(command: string[]): LspInstallRecipe | undefined {
	const binary = basename(command[0] ?? "");
	const recipe = INSTALL_RECIPES[binary];
	return recipe ? { binary, ...recipe } : undefined;
}

/**
 * Install hint for a server launch command, or undefined for unknown binaries.
 * Matches on the binary basename so absolute-path commands still get a hint.
 */
export function installHintForCommand(command: string[]): string | undefined {
	const binary = basename(command[0] ?? "");
	return INSTALL_RECIPES[binary]?.installHint ?? MANUAL_INSTALL_HINTS[binary];
}

const SEVERITY_TO_NUMBER: Record<LspSeverity, number> = {
	error: 1,
	warning: 2,
	information: 3,
	hint: 4,
};

export const SEVERITY_NAMES: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

function normalizeExtension(ext: string): string {
	return (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();
}

/** Merge user LSP settings over built-in defaults into a resolved config. */
export function resolveLspConfig(settings: LspSettings | undefined): ResolvedLspConfig {
	const names = new Set([...Object.keys(DEFAULT_LSP_SERVERS), ...Object.keys(settings?.servers ?? {})]);
	const servers: ResolvedLspServerConfig[] = [];
	for (const name of names) {
		const defaults = DEFAULT_LSP_SERVERS[name] as (typeof DEFAULT_LSP_SERVERS)[string] | undefined;
		const overrides = settings?.servers?.[name];
		if (overrides?.enabled === false) {
			continue;
		}
		const command = overrides?.command ?? defaults?.command;
		const fileExtensions = overrides?.fileExtensions ?? defaults?.fileExtensions;
		if (!command || command.length === 0 || !fileExtensions || fileExtensions.length === 0) {
			continue;
		}
		const commandBinary = basename(command[0] ?? "");
		const builtInBinary = defaults ? basename(defaults.command[0] ?? "") : undefined;
		const usesBuiltInBinary = builtInBinary !== undefined && commandBinary === builtInBinary;
		const installRecipe = usesBuiltInBinary ? installRecipeForCommand(command) : undefined;
		const installHint = installHintForCommand(command);
		servers.push({
			name,
			command: [...command],
			fileExtensions: fileExtensions.map(normalizeExtension),
			rootMarkers: [...(overrides?.rootMarkers ?? defaults?.rootMarkers ?? [])],
			initializationOptions: overrides?.initializationOptions,
			settings: overrides?.settings,
			...(installRecipe ? { installRecipe } : {}),
			...(installHint ? { installHint } : {}),
		});
	}
	return {
		enabled: settings?.enabled ?? true,
		servers,
		settleMs: settings?.settleMs ?? 1500,
		firstSettleMs: settings?.firstSettleMs ?? 10000,
		maxDiagnostics: settings?.maxDiagnostics ?? 20,
		idleShutdownMs: settings?.idleShutdownMs ?? 600000,
		traceFile: settings?.traceFile,
		maxSeverity: SEVERITY_TO_NUMBER[settings?.severity ?? "error"],
	};
}

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".java": "java",
	".rb": "ruby",
	".php": "php",
	".cs": "csharp",
	".json": "json",
	".css": "css",
	".html": "html",
	".md": "markdown",
	".yaml": "yaml",
	".yml": "yaml",
	".sh": "shellscript",
	".bash": "shellscript",
	".lua": "lua",
	".zig": "zig",
	".swift": "swift",
	".kt": "kotlin",
};

/** Map a file extension (with leading dot) to an LSP languageId. Falls back to the extension without the dot. */
export function languageIdForExtension(ext: string): string {
	const normalized = ext.toLowerCase();
	return LANGUAGE_IDS[normalized] ?? (normalized.startsWith(".") ? normalized.slice(1) : normalized);
}
