/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createSessionId } from "@hansjm10/volt-agent-core";
import { type ImageContent, modelsAreEqual } from "@hansjm10/volt-ai";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import {
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	getPackageDir,
	getSessionsDir,
	isStandaloneBinary,
	VERSION,
} from "./config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import {
	assertValidSessionId,
	findSessionInfoById,
	getDefaultSessionDirPath,
	type SessionInfo,
	SessionManager,
	type SessionReference,
} from "./core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "./core/session-store/index.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { SubagentManager } from "./core/subagents/index.ts";
import { initTheme, stopThemeWatcher } from "./core/theme/runtime.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { handleDaemonCommand } from "./daemon/cli.ts";
import { handleRemoteControlCommand } from "./daemon/remote-cli.ts";
import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "./daemon/worktree-manager.ts";
import { handleMcpCommand } from "./mcp-cli.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { handleStoreCommand } from "./store/store-cli.ts";
import { canonicalizePath, isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveRequestedProfile(parsed: Args): string | undefined {
	const profile = parsed.profile ?? process.env.VOLT_PROFILE;
	const trimmed = profile?.trim();
	return trimmed ? trimmed : undefined;
}

function stripCommandProfileArgs(args: readonly string[]): { args: string[]; profile?: string; error?: string } {
	const commandArgs: string[] = [];
	let profile: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--profile") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { args: [...args], error: "--profile requires a value" };
			}
			profile = value;
			index++;
			continue;
		}
		commandArgs.push(arg);
	}

	return { args: commandArgs, profile };
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument. Paths are explicit JSONL import sources only. */
type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; ref: SessionReference }
	| { type: "global"; ref: SessionReference; cwd: string }
	| { type: "not_found"; arg: string };

function sameFilesystemLocation(left: string, right: string): boolean {
	return canonicalizePath(resolvePath(left)) === canonicalizePath(resolvePath(right));
}

function canBeExactSessionId(value: string): boolean {
	try {
		assertValidSessionId(value);
		return true;
	} catch {
		return false;
	}
}

function hasSessionStore(sessionDirectory: string): boolean {
	return existsSync(join(resolvePath(sessionDirectory), SESSION_STORE_DATABASE_FILENAME));
}

async function findExactSessionInfoInStore(
	sessionDirectory: string,
	sessionId: string,
): Promise<SessionInfo | undefined> {
	const directory = resolvePath(sessionDirectory);
	if (!hasSessionStore(directory)) return undefined;
	return findSessionInfoById(directory, sessionId);
}

async function findSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ ref: SessionReference; cwd: string } | undefined> {
	if (sessionDir) {
		const info = await findExactSessionInfoInStore(sessionDir, sessionId);
		return info ? { ref: info.ref, cwd: info.cwd } : undefined;
	}

	const storeErrors: unknown[] = [];
	let readableStores = 0;
	const findInReadableStore = async (directory: string): Promise<SessionInfo | undefined> => {
		if (!hasSessionStore(directory)) return undefined;
		try {
			const info = await findSessionInfoById(directory, sessionId);
			readableStores++;
			return info;
		} catch (error) {
			storeErrors.push(error);
			return undefined;
		}
	};

	const localSessionDir = getDefaultSessionDirPath(cwd);
	const localInfo = await findInReadableStore(localSessionDir);
	if (localInfo) return { ref: localInfo.ref, cwd: localInfo.cwd };

	const sessionsRoot = getSessionsDir();
	if (existsSync(sessionsRoot)) {
		const localStorePath = canonicalizePath(resolvePath(localSessionDir));
		const directories = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name))
			.filter((directory) => canonicalizePath(resolvePath(directory)) !== localStorePath)
			.sort();
		for (const directory of directories) {
			const info = await findInReadableStore(directory);
			if (info) return { ref: info.ref, cwd: info.cwd };
		}
	}
	if (readableStores === 0 && storeErrors.length > 0) {
		throw new AggregateError(storeErrors, "Could not look up an exact session ID in any project store");
	}
	return undefined;
}

async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; ref: SessionReference } | undefined> {
	const directory = sessionDir ?? getDefaultSessionDirPath(cwd);
	const info = await findExactSessionInfoInStore(directory, sessionId);
	if (!info || (info.cwd && !sameFilesystemLocation(info.cwd, cwd))) return undefined;
	return { type: "local", ref: info.ref };
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs use indexed summary lookup; only the final owner opens the selected transcript.
	const exactMatch = canBeExactSessionId(sessionArg)
		? await findSessionByExactId(sessionArg, cwd, sessionDir)
		: undefined;
	if (exactMatch) {
		return !exactMatch.cwd || sameFilesystemLocation(exactMatch.cwd, cwd)
			? { type: "local", ref: exactMatch.ref }
			: { type: "global", ref: exactMatch.ref, cwd: exactMatch.cwd };
	}

	// Prefix matching intentionally remains visible-session enumeration.
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localPrefixMatch = localSessions.find((session) => session.id.startsWith(sessionArg));
	if (localPrefixMatch) return { type: "local", ref: localPrefixMatch.ref };

	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch = allSessions.find((session) => session.id.startsWith(sessionArg));
	if (globalMatch) return { type: "global", ref: globalMatch.ref, cwd: globalMatch.cwd };

	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function forkSessionOrExit(
	source: Extract<ResolvedSession, { type: "path" | "local" | "global" }>,
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
): Promise<SessionManager> {
	try {
		return source.type === "path"
			? await SessionManager.importFromJsonl(source.path, cwd, sessionDir, { id: sessionId ?? createSessionId() })
			: await SessionManager.forkFrom(source.ref, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
				return SessionManager.importFromJsonl(resolved.path, undefined, sessionDir);

			case "local":
				return SessionManager.open(resolved.ref);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedRef = await selectSession(
				(onProgress, query) =>
					query ? SessionManager.search(cwd, query, sessionDir) : SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress, query) =>
					query ? SessionManager.searchAll(query, sessionDir) : SessionManager.listAll(sessionDir, onProgress),
			);
			if (!selectedRef) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedRef);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.ref);
		}
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}
	if (parsed.plan) {
		options.agentMode = "plan";
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.allowUnlistedExtensionTools) {
		options.allowUnlistedExtensionTools = true;
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

async function throwAfterClosingSessionManager(
	manager: SessionManager,
	error: unknown,
	message: string,
): Promise<never> {
	try {
		await manager.closePersistence();
	} catch (closeError) {
		throw new AggregateError([error, closeError], message);
	}
	throw error;
}

class CliSessionManagerOwner {
	private manager: SessionManager | undefined;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	get current(): SessionManager {
		if (!this.manager) throw new Error("CLI session manager ownership has already transferred");
		return this.manager;
	}

	private release(): SessionManager | undefined {
		const manager = this.manager;
		this.manager = undefined;
		return manager;
	}

	async close(): Promise<void> {
		const manager = this.release();
		if (manager) await manager.closePersistence();
	}

	async fail(error: unknown, message: string): Promise<never> {
		const manager = this.release();
		if (!manager) throw error;
		return throwAfterClosingSessionManager(manager, error, message);
	}

	async replace(replacement: SessionManager): Promise<void> {
		const previous = this.release();
		if (!previous) {
			await replacement.closePersistence();
			throw new Error("Cannot replace a CLI session manager after ownership transferred");
		}
		try {
			await previous.closePersistence();
		} catch (error) {
			try {
				await replacement.closePersistence();
			} catch (replacementCloseError) {
				throw new AggregateError(
					[error, replacementCloseError],
					"CLI session manager replacement failed and neither manager closed cleanly",
				);
			}
			throw error;
		}
		this.manager = replacement;
	}

	transfer(): SessionManager {
		const manager = this.release();
		if (!manager) throw new Error("CLI session manager ownership has already transferred");
		return manager;
	}
}

async function runWithOwnedAgentSessionRuntime(
	runtime: AgentSessionRuntime,
	operation: (transferRuntime: () => void) => Promise<void>,
): Promise<void> {
	let runtimeOwned = true;
	let operationError: unknown;
	let operationFailed = false;
	try {
		await operation(() => {
			runtimeOwned = false;
		});
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}

	let cleanupError: unknown;
	let cleanupFailed = false;
	if (runtimeOwned) {
		try {
			await runtime.dispose();
		} catch (error) {
			cleanupFailed = true;
			cleanupError = error;
		}
	}
	if (operationFailed && cleanupFailed) {
		throw new AggregateError([operationError, cleanupError], "CLI runtime setup failed and cleanup did not complete");
	}
	if (operationFailed) throw operationError;
	if (cleanupFailed) throw cleanupError;
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.VOLT_OFFLINE);
	if (offlineMode) {
		process.env.VOLT_OFFLINE = "1";
		process.env.VOLT_SKIP_VERSION_CHECK = "1";
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	const commandProfileArgs = stripCommandProfileArgs(args);
	if (commandProfileArgs.error) {
		console.error(chalk.red(`Error: ${commandProfileArgs.error}`));
		process.exitCode = 1;
		return;
	}
	const commandRuntimeOptions = {
		extensionFactories: options?.extensionFactories,
		profile:
			commandProfileArgs.profile !== undefined
				? commandProfileArgs.profile.trim() || undefined
				: process.env.VOLT_PROFILE?.trim() || undefined,
	};

	if (await handleDaemonCommand(commandProfileArgs.args, { isStandaloneBinary })) {
		return;
	}

	if (await handleRemoteControlCommand(commandProfileArgs.args, { isStandaloneBinary })) {
		return;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: false,
		profile: commandProfileArgs.profile,
	});
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handleStoreCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	if (await handlePackageCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && commandProfileArgs.args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `volt update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	if (await handleMcpCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	const parsed = parseArgs(args);
	const requestedProfile = resolveRequestedProfile(parsed);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	const requestedSessionName = parsed.name?.trim();
	if (parsed.name !== undefined && !requestedSessionName) {
		console.error(chalk.red("Error: --name requires a non-empty value"));
		process.exit(1);
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir, { profile: requestedProfile });
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	// From this point until createAgentSessionRuntime() is invoked, this is the sole
	// owner/finalizer for the acquired manager. Replacement closes the old manager
	// before adopting the new one; transfer relinquishes it at the runtime-factory boundary.
	const sessionManagerOwner = new CliSessionManagerOwner(
		await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager),
	);
	let missingSessionCwdIssue: SessionCwdIssue | undefined;
	try {
		missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManagerOwner.current, cwd);
	} catch (error) {
		return await sessionManagerOwner.fail(error, "Session cwd validation failed and its manager could not be closed");
	}
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			let selectedCwd: string | undefined;
			try {
				selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			} catch (error) {
				return await sessionManagerOwner.fail(
					error,
					"Session cwd selection failed and its manager could not be closed",
				);
			}
			if (!selectedCwd) {
				await sessionManagerOwner.close();
				process.exitCode = 0;
				return;
			}
			let replacementManager: SessionManager;
			try {
				replacementManager = await SessionManager.open(missingSessionCwdIssue.sessionRef!, selectedCwd);
			} catch (error) {
				return await sessionManagerOwner.fail(
					error,
					"Session cwd replacement failed and its original manager could not be closed",
				);
			}
			await sessionManagerOwner.replace(replacementManager);
		} else {
			const error = new MissingSessionCwdError(missingSessionCwdIssue);
			try {
				await sessionManagerOwner.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Invalid session cwd and manager close both failed");
			}
			console.error(chalk.red(error.message));
			process.exitCode = 1;
			return;
		}
	}
	if (requestedSessionName) {
		try {
			sessionManagerOwner.current.appendSessionInfo(requestedSessionName);
			await sessionManagerOwner.current.flush();
		} catch (error) {
			return await sessionManagerOwner.fail(error, "Session naming failed and its manager could not be closed");
		}
	}
	time("createSessionManager");

	let trustStore: ProjectTrustStore;
	let sessionCwd: string;
	let autoTrustOnReloadCwd: string | undefined;
	let trustPromptMode: AppMode;
	let resolvedExtensionPaths: string[] | undefined;
	let resolvedSkillPaths: string[] | undefined;
	let resolvedPromptTemplatePaths: string[] | undefined;
	let resolvedThemePaths: string[] | undefined;
	let authStorage: AuthStorage;
	try {
		trustStore = new ProjectTrustStore(agentDir);
		sessionCwd = sessionManagerOwner.current.getCwd();
		autoTrustOnReloadCwd =
			parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
				? sessionCwd
				: undefined;
		trustPromptMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
		resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
		resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
		resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
		resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
		authStorage = AuthStorage.create();
	} catch (error) {
		return await sessionManagerOwner.fail(
			error,
			"Session startup preparation failed and its manager could not be closed",
		);
	}
	const projectTrustByCwd = new Map<string, boolean>();
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const { cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext, subagentContext } = runtimeOptions;
		const runtimeProfile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : requestedProfile;
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		// Daemon-managed worktree checkouts pin trust to the PARENT checkout:
		// prompts and trust.json entries always target the parent workspace path,
		// never a path under ~/.volt/agent/worktrees (worktrees-design §5.2.1).
		// When the parent cannot be resolved, the worktree runs untrusted rather
		// than prompting for (or persisting) the worktree path.
		const worktreeParentPath = resolveWorktreeParentCheckout(agentDir, cwd);
		const trustPath = worktreeParentPath ?? (isPathUnderWorktreesRoot(agentDir, cwd) ? undefined : cwd);
		const cachedProjectTrust = trustPath === undefined ? undefined : projectTrustByCwd.get(trustPath);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined &&
			cachedProjectTrust === undefined &&
			hasTrustRequiringResources &&
			trustPath !== undefined;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || (trustPath !== undefined && trustStore.get(trustPath) === true)));
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted,
			profile: runtimeProfile,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			settingsManager: runtimeSettingsManager,
			workspaceName: runtimeOptions.workspaceName,
			baseRef: runtimeOptions.baseRef,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions:
				shouldResolveProjectTrust && trustPath !== undefined
					? {
							resolveProjectTrust: async ({ extensionsResult }) => {
								const trusted = await resolveProjectTrusted({
									cwd: trustPath,
									trustStore,
									trustOverride: parsed.projectTrustOverride,
									defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
									extensionsResult,
									projectTrustContext:
										projectTrustContext ??
										createProjectTrustContext({
											cwd: trustPath,
											mode: isInitialRuntime ? trustPromptMode : appMode,
											settingsManager: startupSettingsManager,
											hasUI: isInitialRuntime && trustPromptMode === "interactive",
										}),
									onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
								});
								projectTrustByCwd.set(trustPath, trusted);
								return trusted;
							},
						}
					: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		let subagentManager: SubagentManager | undefined;
		try {
			const { settingsManager, modelRegistry, resourceLoader } = services;
			if (parsed.lsp) {
				settingsManager.applyOverrides({ lsp: { enabled: true } });
			}
			const diagnostics: AgentSessionRuntimeDiagnostic[] = [
				...projectTrustDiagnostics,
				...services.diagnostics,
				...collectSettingsDiagnostics(settingsManager, "runtime creation"),
				...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
					type: "error" as const,
					message: `Failed to load extension "${path}": ${error}`,
				})),
			];

			const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
			const scopedModels =
				modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
			const hasExistingSession = sessionStartEvent?.reason !== "new" && sessionManager.getBranch().length > 0;
			const { options: sessionOptions, diagnostics: sessionOptionDiagnostics } = buildSessionOptions(
				parsed,
				scopedModels,
				hasExistingSession,
				modelRegistry,
				settingsManager,
			);
			diagnostics.push(...sessionOptionDiagnostics);

			if (parsed.apiKey) {
				if (!sessionOptions.model) {
					diagnostics.push({
						type: "error",
						message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
					});
				} else {
					authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
				}
			}

			subagentManager = new SubagentManager({
				createRuntime,
				cwd,
				agentDir,
				workspaceName: services.workspaceName,
				baseRef: services.baseRef,
				resourceLoader,
				parentSessionManager: sessionManager,
				...(subagentContext ? { subagentContext } : {}),
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: sessionOptions.model,
				thinkingLevel: sessionOptions.thinkingLevel,
				agentMode: sessionStartEvent ? undefined : sessionOptions.agentMode,
				scopedModels: sessionOptions.scopedModels,
				tools: sessionOptions.tools,
				allowUnlistedExtensionTools: sessionOptions.allowUnlistedExtensionTools,
				excludeTools: sessionOptions.excludeTools,
				noTools: sessionOptions.noTools,
				customTools: sessionOptions.customTools,
				subagentToolManager: subagentManager,
			});

			return {
				...created,
				services,
				diagnostics,
			};
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (subagentManager) {
				try {
					await subagentManager.dispose();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			try {
				services.gitContextProvider.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Agent session creation failed and untransferred CLI services could not be disposed",
				);
			}
			throw error;
		}
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionCwd,
		agentDir,
		sessionManager: sessionManagerOwner.transfer(),
	});
	time("createAgentSessionRuntime");
	await runWithOwnedAgentSessionRuntime(runtime, async (transferRuntime) => {
		const { services, session, modelFallbackMessage } = runtime;
		const { settingsManager, modelRegistry, resourceLoader } = services;
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

		if (parsed.help) {
			const extensionFlags = resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => Array.from(extension.flags.values()));
			printHelp(extensionFlags);
			return;
		}

		if (parsed.listModels !== undefined) {
			const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
			await listModels(modelRegistry, searchPattern);
			return;
		}

		// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
		let stdinContent: string | undefined;
		if (appMode !== "rpc") {
			stdinContent = await readPipedStdin();
			if (stdinContent !== undefined && appMode === "interactive") {
				appMode = "print";
			}
		}
		time("readPipedStdin");

		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");
		initTheme(settingsManager.getTheme(), appMode === "interactive");
		time("initTheme");

		// Show deprecation warnings in interactive mode
		if (appMode === "interactive" && deprecationWarnings.length > 0) {
			await showDeprecationWarnings(deprecationWarnings);
		}

		time("resolveModelScope");
		reportDiagnostics(runtime.diagnostics);
		if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exitCode = 1;
			return;
		}
		time("createAgentSession");

		if (appMode !== "interactive" && !session.model) {
			console.error(chalk.red(formatNoModelsAvailableMessage()));
			process.exitCode = 1;
			return;
		}

		const startupBenchmark = isTruthyEnvFlag(process.env.VOLT_STARTUP_BENCHMARK);
		if (startupBenchmark && appMode !== "interactive") {
			console.error(chalk.red("Error: VOLT_STARTUP_BENCHMARK only supports interactive mode"));
			process.exitCode = 1;
			return;
		}

		if (appMode === "rpc") {
			printTimings();
			transferRuntime();
			await runRpcMode(runtime, {
				onReady: () => {
					void runtime.startRecoveredClientInputs().catch(() => undefined);
				},
			});
		} else if (appMode === "interactive") {
			const interactiveMode = new InteractiveMode(runtime, {
				migratedProviders,
				modelFallbackMessage,
				modelScopePatterns: parsed.models,
				autoTrustOnReloadCwd,
				initialMessage,
				initialImages,
				initialMessages: parsed.messages,
				verbose: parsed.verbose,
				...(parsed.tuiMode !== undefined ? { tuiMode: parsed.tuiMode } : {}),
			});
			if (startupBenchmark) {
				await interactiveMode.init();
				time("interactiveMode.init");
				printTimings();
				interactiveMode.stop();
				stopThemeWatcher();
				if (process.stdout.writableLength > 0) {
					await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
				}
				if (process.stderr.writableLength > 0) {
					await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
				}
				return;
			}

			printTimings();
			transferRuntime();
			await interactiveMode.run();
		} else {
			printTimings();
			transferRuntime();
			const exitCode = await runPrintMode(runtime, {
				mode: toPrintOutputMode(appMode),
				messages: parsed.messages,
				initialMessage,
				initialImages,
			});
			stopThemeWatcher();
			restoreStdout();
			if (exitCode !== 0) {
				process.exitCode = exitCode;
			}
			return;
		}
	});
}
