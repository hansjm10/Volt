/**
 * RTK command rewrite extension.
 *
 * Rewrites bash tool calls through `rtk rewrite` so Volt receives token-optimized
 * command output from supported commands.
 *
 * Usage:
 *   1. Install RTK and ensure `rtk` is on PATH.
 *   2. Copy this file to ~/.volt/agent/extensions/rtk.ts or .volt/extensions/rtk.ts.
 *   3. Restart Volt or run /reload.
 */

import type { BashToolCallEvent, ExecResult, ExtensionAPI, ToolCallEvent } from "@earendil-works/volt-coding-agent";

const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;

type Semver = [major: number, minor: number, patch: number];

function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
	return event.toolName === "bash";
}

function parseSemver(raw: string): Semver | undefined {
	const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function isSupportedRtkVersion(versionOutput: string): boolean {
	const parsed = parseSemver(versionOutput.replace(/^rtk\s+/, ""));
	if (!parsed) return true;
	const [major, minor] = parsed;
	return major > 0 || minor >= MIN_SUPPORTED_RTK_MINOR;
}

function isRewriteResult(result: ExecResult): boolean {
	return result.code === 0 || result.code === 3;
}

async function rewriteCommand(
	volt: ExtensionAPI,
	command: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const result = await volt.exec("rtk", ["rewrite", command], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	});
	if (result.killed || !isRewriteResult(result)) return undefined;
	return result.stdout.trim() || undefined;
}

async function probeRtk(volt: ExtensionAPI): Promise<boolean> {
	try {
		const version = await volt.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS });
		if (version.code !== 0) {
			console.warn("[rtk] rtk binary not found in PATH; extension disabled");
			return false;
		}
		if (!isSupportedRtkVersion(version.stdout)) {
			console.warn(`[rtk] ${version.stdout.trim()} is too old; need rtk >= 0.23.0`);
			return false;
		}
		return true;
	} catch (error) {
		console.warn("[rtk] failed to probe rtk; extension disabled", error);
		return false;
	}
}

export default async function rtkExtension(volt: ExtensionAPI) {
	const rtkAvailable = await probeRtk(volt);
	if (!rtkAvailable) return;

	volt.on("tool_call", async (event, ctx) => {
		try {
			if (!isBashToolCallEvent(event)) return;
			if (process.env.RTK_DISABLED === "1") return;

			const command = event.input.command;
			if (typeof command !== "string" || command.trim() === "") return;
			if (command.trimStart().startsWith("rtk ")) return;

			const rewritten = await rewriteCommand(volt, command, ctx.signal);
			if (rewritten && rewritten !== command) {
				event.input.command = rewritten;
			}
		} catch (error) {
			console.warn("[rtk] unexpected error in tool_call handler; passing through command", error);
		}
	});
}
