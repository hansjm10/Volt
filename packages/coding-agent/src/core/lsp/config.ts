/**
 * LSP configuration: settings types, built-in server defaults, and resolution.
 *
 * Server definitions are config-driven. Users add or override servers via the
 * `lsp.servers` settings block; built-in defaults cover common languages and
 * are only used when the matching server binary is installed.
 */

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
	/** Enable LSP diagnostics after edit/write. Default: false (also enabled per run via --lsp) */
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
}

export interface ResolvedLspConfig {
	enabled: boolean;
	servers: ResolvedLspServerConfig[];
	settleMs: number;
	firstSettleMs: number;
	maxDiagnostics: number;
	idleShutdownMs: number;
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
};

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
		servers.push({
			name,
			command: [...command],
			fileExtensions: fileExtensions.map(normalizeExtension),
			rootMarkers: [...(overrides?.rootMarkers ?? defaults?.rootMarkers ?? [])],
			initializationOptions: overrides?.initializationOptions,
			settings: overrides?.settings,
		});
	}
	return {
		enabled: settings?.enabled ?? false,
		servers,
		settleMs: settings?.settleMs ?? 1500,
		firstSettleMs: settings?.firstSettleMs ?? 10000,
		maxDiagnostics: settings?.maxDiagnostics ?? 20,
		idleShutdownMs: settings?.idleShutdownMs ?? 600000,
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
