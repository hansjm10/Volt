import { homedir } from "node:os";
import { resolve } from "node:path";

export interface SwarmConfig {
	prNumber: number;
	workspaceName: string;
	remote: string;
	pollMs: number;
	checks: string[];
	once: boolean;
	dryRun: boolean;
	cwd: string;
	swarmDir: string;
}

const MINIMUM_POLL_MS = 1_000;
const DEFAULT_POLL_MS = 30_000;

export function parseSwarmArgs(argv: readonly string[], cwd = process.cwd()): SwarmConfig {
	let prNumber: number | undefined;
	let workspaceName: string | undefined;
	let remote = "origin";
	let pollMs = DEFAULT_POLL_MS;
	const checks: string[] = [];
	let once = false;
	let dryRun = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (!argument.startsWith("-")) {
			if (prNumber !== undefined) throw new Error(`Unexpected positional argument: ${argument}`);
			prNumber = parsePositiveInteger(argument, "PR number");
			continue;
		}
		switch (argument) {
			case "--workspace":
				workspaceName = requireValue(argv, ++index, argument);
				break;
			case "--remote":
				remote = requireValue(argv, ++index, argument);
				break;
			case "--poll-ms":
				pollMs = parsePositiveInteger(requireValue(argv, ++index, argument), "poll interval");
				if (pollMs < MINIMUM_POLL_MS) throw new Error(`Poll interval must be at least ${MINIMUM_POLL_MS}ms`);
				break;
			case "--check": {
				const command = requireValue(argv, ++index, argument).trim();
				if (command.length === 0) throw new Error("Validation commands must not be empty");
				checks.push(command);
				break;
			}
			case "--once":
				once = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--help":
			case "-h":
				throw new SwarmHelpError();
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}

	if (prNumber === undefined) throw new Error("A PR number is required");
	if (!workspaceName?.trim()) throw new Error("--workspace is required");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(remote)) throw new Error("--remote must be a Git remote name");
	if (!dryRun && checks.length === 0) throw new Error("Write mode requires at least one --check command");

	return {
		prNumber,
		workspaceName: workspaceName.trim(),
		remote,
		pollMs,
		checks,
		once,
		dryRun,
		cwd: resolve(cwd),
		swarmDir: resolve(homedir(), ".volt", "agent", "swarm"),
	};
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function parsePositiveInteger(value: string, label: string): number {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
	return parsed;
}

export class SwarmHelpError extends Error {
	constructor() {
		super(formatSwarmUsage());
		this.name = "SwarmHelpError";
	}
}

export function formatSwarmUsage(): string {
	return [
		"Usage: npm run pr-swarm:poc -- <pr-number> --workspace <name> [options]",
		"",
		"Options:",
		"  --remote <name>      Git remote containing the PR branch (default: origin)",
		"  --poll-ms <ms>       Non-overlapping poll interval (default: 30000; minimum: 1000)",
		"  --check <command>    Trusted shell validation command; repeatable and required in write mode",
		"  --once               Process one scheduling cycle, then stop",
		"  --dry-run            Suppress GitHub writes and pushes",
	].join("\n");
}
