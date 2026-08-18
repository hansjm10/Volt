import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { Container, createRenderFrame, Text, truncateToWidth } from "@hansjm10/volt-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	terminateProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { highlightShellCommand, theme } from "../theme/runtime.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { formatDuration, getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

/**
 * Seconds of silence after which a command is presumed hung and killed.
 *
 * A wall-clock limit is a poor hang detector: it has to be set higher than the
 * command's legitimate runtime, so the gap between "hung" and "killed" is pure
 * dead time. Silence is the signal that actually distinguishes a hung command
 * from a slow one, and it does not require guessing how long the work takes.
 *
 * Sized against gemini-cli's `tools.shell.inactivityTimeout`, which also
 * defaults to 300s. Plenty of legitimate commands (dependency installs, release
 * builds) go quiet for minutes at a time, and a false kill costs more than a
 * slower detection.
 */
const DEFAULT_STALL_TIMEOUT_SECONDS = 300;

/** Upper bound applied to explicitly requested timeouts. */
const MAX_TIMEOUT_SECONDS = 3600;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Overall wall-clock limit in seconds (max ${MAX_TIMEOUT_SECONDS}). Usually unnecessary: a command that goes silent for ${DEFAULT_STALL_TIMEOUT_SECONDS}s is killed automatically, so there is no need to inflate this to protect against hangs.`,
		}),
	),
	stallTimeout: Type.Optional(
		Type.Number({
			description: `Seconds without output before the command is presumed hung and killed (default ${DEFAULT_STALL_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}, 0 disables). Raise this only for commands that are legitimately silent for long stretches.`,
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Normalize a caller-supplied timeout to a usable number of seconds.
 * Returns undefined for absent, non-finite, or non-positive values.
 */
function clampTimeoutSeconds(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(value, MAX_TIMEOUT_SECONDS);
}

/**
 * Resolve the silence deadline. Only an exact 0 disables it — a malformed or
 * negative value falls back to the default rather than silently switching the
 * safeguard off.
 */
function resolveStallSeconds(value: number | undefined): number {
	if (value === 0) return 0;
	if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_STALL_TIMEOUT_SECONDS;
	return Math.min(value, MAX_TIMEOUT_SECONDS);
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using volt's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want volt's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			// Lets the teardown skip its SIGKILL escalation once the shell is gone,
			// so a recycled pid is never signalled.
			let exited = false;
			child.once("exit", () => {
				exited = true;
			});
			// The wall timeout and an abort can both fire; without this guard each
			// would run its own process-table sweep and signal rounds.
			let tornDown = false;
			const teardown = () => {
				if (tornDown || exited || !child.pid) return;
				tornDown = true;
				void terminateProcessTree(child.pid, () => exited);
			};

			try {
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						teardown();
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) teardown();
					else signal.addEventListener("abort", teardown, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", teardown);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	// Show the limit actually in force, not the raw request, so an inflated
	// value is not displayed as though it were honored.
	const timeout = clampTimeoutSeconds(args?.timeout as number | undefined);
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay =
		command === null
			? invalidArgText(theme)
			: command
				? highlightShellCommand(command, "toolTitle").join("\n")
				: theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold("$ ")) + commandDisplay + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return createRenderFrame(["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])]);
					}
					return createRenderFrame(["", ...(state.cachedLines ?? [])]);
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. A command that produces no output for ${DEFAULT_STALL_TIMEOUT_SECONDS}s is killed as hung, so long-running commands do not need a large timeout to be safe.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout, stallTimeout }: { command: string; timeout?: number; stallTimeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const wallTimeout = clampTimeoutSeconds(timeout);
			const stallSeconds = resolveStallSeconds(stallTimeout);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "volt-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						...(snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {}),
						...(snapshot.fullOutputPath === undefined ? {} : { fullOutputPath: snapshot.fullOutputPath }),
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [] });
			}

			const stallController = new AbortController();
			// Latched when each cause fires. Re-reading signal.aborted in the catch
			// block instead would mislabel a stall as a plain abort whenever the run
			// is torn down between the kill and the error surfacing, hiding from the
			// model that the command hung — so it would retry the same hang.
			let abortCause: "stall" | "caller" | undefined;
			const markCallerAbort = () => {
				abortCause ??= "caller";
			};
			let stallTimer: NodeJS.Timeout | undefined;

			const clearStallTimer = () => {
				if (stallTimer) {
					clearTimeout(stallTimer);
					stallTimer = undefined;
				}
			};

			// Re-armed on every chunk, so the deadline tracks silence rather than
			// total runtime: a command that keeps talking is never killed by it.
			const armStallTimer = () => {
				clearStallTimer();
				if (stallSeconds <= 0) return;
				stallTimer = setTimeout(() => {
					abortCause ??= "stall";
					stallController.abort();
				}, stallSeconds * 1000);
			};

			const handleData = (data: Buffer) => {
				armStallTimer();
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = {
						truncation,
						...(snapshot.fullOutputPath === undefined ? {} : { fullOutputPath: snapshot.fullOutputPath }),
					};
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					armStallTimer();
					if (signal) {
						if (signal.aborted) markCallerAbort();
						else signal.addEventListener("abort", markCallerAbort, { once: true });
					}
					const execSignal = signal ? AbortSignal.any([signal, stallController.signal]) : stallController.signal;
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal: execSignal,
						timeout: wallTimeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						// Whichever cause fired first wins: a caller abort makes the
						// command fall silent as a side effect, and a stall kill can be
						// followed by a caller abort before this branch runs.
						if (abortCause === "stall") {
							throw new Error(
								appendStatus(
									text,
									`Command produced no output for ${stallSeconds} seconds and was killed as hung. If this command is legitimately silent for longer, pass a larger stallTimeout.`,
								),
							);
						}
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return {
					content: [{ type: "text", text: outputText }],
					...(details === undefined ? {} : { details }),
				};
			} finally {
				clearUpdateTimer();
				clearStallTimer();
				signal?.removeEventListener("abort", markCallerAbort);
			}
		},
		// The result renderer shows its own "Elapsed/Took" duration line, so the
		// generic tool-header duration suffix is suppressed.
		rendersDuration: true,
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(
	cwd: string,
	options?: BashToolOptions,
): AgentTool<typeof bashSchema, BashToolDetails | undefined> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
