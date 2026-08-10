import type { GitHubSnapshot } from "./github.ts";
import { requiredChecksStatus } from "./github.ts";
import type { SwarmState } from "./state.ts";
import type { LoggerAdapter } from "./swarm.ts";

interface ReporterOutput {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(text: string): unknown;
}

interface TerminalSwarmReporterOptions {
	output?: ReporterOutput;
	errorOutput?: ReporterOutput;
	now?: () => Date;
	dryRun?: boolean;
}

interface ReporterEvent {
	level: "info" | "warn" | "error";
	message: string;
	time: Date;
}

const MAX_EVENTS = 8;
const MAX_JOBS = 8;

export class TerminalSwarmReporter implements LoggerAdapter {
	private readonly output: ReporterOutput;
	private readonly errorOutput: ReporterOutput;
	private readonly now: () => Date;
	private readonly interactive: boolean;
	private readonly dryRun: boolean;
	private readonly events: ReporterEvent[] = [];
	private state?: SwarmState;
	private snapshot?: GitHubSnapshot;
	private screenActive = false;
	private closed = false;
	private lastPlainStatus = "";

	constructor(options: TerminalSwarmReporterOptions = {}) {
		this.output = options.output ?? process.stdout;
		this.errorOutput = options.errorOutput ?? process.stderr;
		this.now = options.now ?? (() => new Date());
		this.interactive = this.output.isTTY === true;
		this.dryRun = options.dryRun ?? false;
	}

	info(message: string): void {
		this.record("info", message);
	}

	warn(message: string): void {
		this.record("warn", message);
	}

	error(message: string): void {
		this.record("error", message);
	}

	update(state: SwarmState, snapshot?: GitHubSnapshot): void {
		if (this.closed) return;
		this.state = structuredClone(state);
		this.snapshot = snapshot ? structuredClone(snapshot) : this.snapshot;
		if (this.interactive) this.renderScreen();
		else this.renderPlainStatus();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.screenActive) {
			this.output.write("\u001b[?25h\u001b[?1049l");
			this.screenActive = false;
		}
		this.output.write(`${timestamp(this.now())} swarm stopped\n`);
	}

	private record(level: ReporterEvent["level"], message: string): void {
		if (this.closed) return;
		const event = { level, message: sanitize(message).trim(), time: this.now() };
		this.events.push(event);
		if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
		if (this.interactive && this.state) this.renderScreen();
		else {
			const target = level === "error" ? this.errorOutput : this.output;
			target.write(`${timestamp(event.time)} ${level.toUpperCase().padEnd(5)} ${event.message}\n`);
		}
	}

	private renderPlainStatus(): void {
		if (!this.state) return;
		const generation = this.state.generations[this.state.currentGenerationSha];
		if (!generation) return;
		const jobs = Object.values(this.state.jobs);
		const checks = this.snapshot ? requiredChecksStatus(this.snapshot) : "unknown";
		const fingerprint = JSON.stringify([
			generation.sha,
			generation.phase,
			generation.review.state,
			checks,
			jobs.map((job) => [job.id, job.state, job.attempts]),
			generation.manualBlockers,
		]);
		if (fingerprint === this.lastPlainStatus) return;
		this.lastPlainStatus = fingerprint;
		this.output.write(
			`${timestamp(this.now())} STATUS head=${generation.sha.slice(0, 12)} phase=${generation.phase} review=${generation.review.state} checks=${checks} jobs=${summarizeJobs(jobs)}\n`,
		);
	}

	private renderScreen(): void {
		if (!this.state) return;
		if (!this.screenActive) {
			this.output.write("\u001b[?1049h\u001b[?25l");
			this.screenActive = true;
		}
		const width = Math.max(20, Math.min(this.output.columns ?? 100, 140));
		const sectionLimit = Math.max(1, Math.min(MAX_JOBS, Math.floor(((this.output.rows ?? 30) - 14) / 2)));
		const generation = this.state.generations[this.state.currentGenerationSha];
		if (!generation) return;
		const jobs = Object.values(this.state.jobs).sort((left, right) => left.createdAt - right.createdAt);
		const checks = this.snapshot ? requiredChecksStatus(this.snapshot) : "unknown";
		const unresolvedThreads = this.snapshot?.threads.filter((thread) => !thread.isResolved).length ?? 0;
		const mode = this.dryRun ? "DRY-RUN" : "LIVE";
		const lines = [
			`Volt PR Swarm  ${mode}  PR #${this.state.prNumber}`,
			"─".repeat(width),
			`Repository: ${this.state.repository}`,
			`Head:       ${generation.sha}`,
			`Phase:      ${generation.phase}`,
			`Review:     ${generation.review.state}${generation.review.error ? ` — ${generation.review.error}` : ""}`,
			`Checks:     ${checks}    Unresolved threads: ${unresolvedThreads}`,
			`Jobs:       ${summarizeJobs(jobs)}`,
			"",
			"Recent jobs",
			...(jobs.length === 0
				? ["  (none)"]
				: jobs.slice(-sectionLimit).map(
						(job) =>
							`  ${job.sourceKind.padEnd(7)} ${job.state.padEnd(18)} attempt ${job.attempts}/${2}  ${job.sourceId}`,
					)),
			...(generation.manualBlockers.length > 0
				? ["", "Manual blockers", ...generation.manualBlockers.map((blocker) => `  ! ${blocker}`)]
				: []),
			"",
			"Recent events",
			...(this.events.length === 0
				? ["  (waiting for activity)"]
				: this.events
						.slice(-sectionLimit)
						.map((event) => `  ${clockTime(event.time)} ${event.level.toUpperCase().padEnd(5)} ${event.message}`)),
			"",
			`Last refresh: ${this.now().toLocaleTimeString()}    Ctrl+C to stop safely`,
		];
		this.output.write(`\u001b[2J\u001b[H${lines.map((line) => truncate(sanitize(line), width)).join("\n")}`);
	}
}

function summarizeJobs(jobs: Array<{ state: string }>): string {
	if (jobs.length === 0) return "none";
	const counts = new Map<string, number>();
	for (const job of jobs) counts.set(job.state, (counts.get(job.state) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([state, count]) => `${state}:${count}`)
		.join(" ");
}

function sanitize(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function timestamp(value: Date): string {
	return value.toISOString();
}

function clockTime(value: Date): string {
	return value.toTimeString().slice(0, 8);
}
