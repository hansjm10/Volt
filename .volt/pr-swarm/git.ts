import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import type { CommandAdapter } from "./command.ts";
import { boundUtf8 } from "./github.ts";
import type { ValidationRun } from "./state.ts";

const VALIDATION_OUTPUT_BYTES = 16 * 1024;

export interface CandidateCommitInspection {
	commit: string;
	parent: string;
	changedFiles: string[];
	clean: boolean;
}

export interface PushResult {
	kind: "pushed" | "stale" | "manual";
	message?: string;
}

export interface GitAdapter {
	assertWorkspaceRoot(workspacePath: string): Promise<string>;
	assertRemoteRepository(remote: string, repository: string): Promise<void>;
	fetchPrivateHead(prNumber: number, remote: string, headRefName: string, expectedSha: string): Promise<string>;
	fetchRemoteHead(prNumber: number, remote: string, headRefName: string): Promise<string>;
	inspectCandidate(worktreePath: string, expectedParent: string): Promise<CandidateCommitInspection>;
	runChecks(worktreePath: string, checks: readonly string[], now: () => number): Promise<ValidationRun[]>;
	cherryPick(worktreePath: string, commit: string): Promise<string>;
	abortCherryPick(worktreePath: string): Promise<void>;
	currentHead(worktreePath: string): Promise<string>;
	worktreeExists(worktreePath: string): Promise<boolean>;
	isClean(worktreePath: string): Promise<boolean>;
	pushHead(worktreePath: string, remote: string, headRefName: string): Promise<PushResult>;
	deleteRef(ref: string, expected?: string): Promise<void>;
}

export class CommandGitAdapter implements GitAdapter {
	private readonly commands: CommandAdapter;
	private readonly cwd: string;

	constructor(commands: CommandAdapter, cwd: string) {
		this.commands = commands;
		this.cwd = cwd;
	}

	async assertWorkspaceRoot(workspacePath: string): Promise<string> {
		const result = await this.commands.run("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd });
		if (result.code !== 0) throw new Error(`Current directory is not a Git repository: ${result.stderr.trim()}`);
		const [root, registered] = await Promise.all([realpath(result.stdout.trim()), realpath(workspacePath)]);
		if (root !== registered) throw new Error(`Registered voltd workspace ${registered} is not the current Git root ${root}`);
		return root;
	}

	async assertRemoteRepository(remote: string, repository: string): Promise<void> {
		const result = await this.commands.run("git", ["remote", "get-url", remote], { cwd: this.cwd });
		if (result.code !== 0) throw new Error(`Git remote ${remote} is unavailable: ${result.stderr.trim()}`);
		const remoteRepository = parseGitHubRepository(result.stdout.trim());
		if (remoteRepository?.toLowerCase() !== repository.toLowerCase()) {
			throw new Error(`Git remote ${remote} targets ${remoteRepository ?? "a non-GitHub repository"}, expected ${repository}`);
		}
	}

	async fetchPrivateHead(
		prNumber: number,
		remote: string,
		headRefName: string,
		expectedSha: string,
	): Promise<string> {
		await this.assertBranchName(headRefName);
		const privateRef = `refs/volt/pr-swarm/pr-${prNumber}/${expectedSha}`;
		const result = await this.commands.run(
			"git",
			["fetch", "--force", "--no-tags", remote, `refs/heads/${headRefName}:${privateRef}`],
			{ cwd: this.cwd },
		);
		if (result.code !== 0) throw new Error(`Failed to fetch PR head: ${result.stderr.trim()}`);
		const fetched = await this.revParse(this.cwd, privateRef);
		if (fetched !== expectedSha) throw new Error(`Fetched PR head ${fetched} does not match captured ${expectedSha}`);
		return privateRef;
	}

	async fetchRemoteHead(prNumber: number, remote: string, headRefName: string): Promise<string> {
		await this.assertBranchName(headRefName);
		const ref = `refs/volt/pr-swarm/pr-${prNumber}/remote-head`;
		const result = await this.commands.run(
			"git",
			["fetch", "--force", "--no-tags", remote, `refs/heads/${headRefName}:${ref}`],
			{ cwd: this.cwd },
		);
		if (result.code !== 0) throw new Error(`Failed to fetch remote PR branch: ${result.stderr.trim()}`);
		return this.revParse(this.cwd, ref);
	}

	async inspectCandidate(worktreePath: string, expectedParent: string): Promise<CandidateCommitInspection> {
		const commit = await this.revParse(worktreePath, "HEAD");
		const parentsResult = await this.commands.run("git", ["rev-list", "--parents", "-n", "1", commit], {
			cwd: worktreePath,
		});
		if (parentsResult.code !== 0) throw new Error(`Could not inspect candidate parents: ${parentsResult.stderr.trim()}`);
		const parts = parentsResult.stdout.trim().split(/\s+/);
		if (parts.length !== 2 || parts[0] !== commit) throw new Error("Candidate must be exactly one non-merge commit");
		const parent = parts[1]!;
		if (parent !== expectedParent) throw new Error(`Candidate parent ${parent} does not match captured head ${expectedParent}`);
		const changedResult = await this.commands.run(
			"git",
			["diff-tree", "--no-commit-id", "--name-only", "-r", commit],
			{ cwd: worktreePath },
		);
		if (changedResult.code !== 0) throw new Error(`Could not inspect candidate diff: ${changedResult.stderr.trim()}`);
		const changedFiles = changedResult.stdout
			.split(/\r?\n/)
			.map((entry) => entry.trim())
			.filter(Boolean);
		if (changedFiles.length === 0) throw new Error("Candidate commit is empty");
		return { commit, parent, changedFiles, clean: await this.isClean(worktreePath) };
	}

	async runChecks(worktreePath: string, checks: readonly string[], now: () => number): Promise<ValidationRun[]> {
		const runs: ValidationRun[] = [];
		for (const command of checks) {
			const result = await this.commands.runShell(command, { cwd: worktreePath, maxOutputBytes: 2 * 1024 * 1024 });
			runs.push({
				command,
				code: result.code,
				stdout: boundUtf8(result.stdout, VALIDATION_OUTPUT_BYTES),
				stderr: boundUtf8(result.stderr, VALIDATION_OUTPUT_BYTES),
				completedAt: now(),
			});
			if (result.code !== 0) break;
		}
		return runs;
	}

	async cherryPick(worktreePath: string, commit: string): Promise<string> {
		const result = await this.commands.run("git", ["cherry-pick", commit], { cwd: worktreePath });
		if (result.code !== 0) throw new Error(`Cherry-pick failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return this.revParse(worktreePath, "HEAD");
	}

	async abortCherryPick(worktreePath: string): Promise<void> {
		await this.commands.run("git", ["cherry-pick", "--abort"], { cwd: worktreePath });
	}

	currentHead(worktreePath: string): Promise<string> {
		return this.revParse(worktreePath, "HEAD");
	}

	async worktreeExists(worktreePath: string): Promise<boolean> {
		return existsSync(worktreePath);
	}

	async isClean(worktreePath: string): Promise<boolean> {
		const result = await this.commands.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd: worktreePath,
		});
		if (result.code !== 0) throw new Error(`Could not inspect worktree status: ${result.stderr.trim()}`);
		return result.stdout.length === 0;
	}

	async pushHead(worktreePath: string, remote: string, headRefName: string): Promise<PushResult> {
		await this.assertBranchName(headRefName);
		const result = await this.commands.run("git", ["push", remote, `HEAD:refs/heads/${headRefName}`], {
			cwd: worktreePath,
		});
		if (result.code === 0) return { kind: "pushed" };
		const message = `${result.stderr}\n${result.stdout}`.trim();
		if (/non-fast-forward|fetch first|stale info|rejected.*behind/i.test(message)) return { kind: "stale", message };
		return { kind: "manual", message: message || `git push exited ${String(result.code)}` };
	}

	async deleteRef(ref: string, expected?: string): Promise<void> {
		if (!/^refs\/(?:volt\/pr-swarm|heads\/volt\/swarm)\//.test(ref)) {
			throw new Error(`Ref is not owned by PR swarm: ${ref}`);
		}
		const args = expected ? ["update-ref", "-d", ref, expected] : ["update-ref", "-d", ref];
		const result = await this.commands.run("git", args, { cwd: this.cwd });
		if (result.code !== 0) throw new Error(`Could not remove owned ref ${ref}: ${result.stderr.trim()}`);
	}

	private async assertBranchName(branch: string): Promise<void> {
		const result = await this.commands.run("git", ["check-ref-format", "--branch", branch], { cwd: this.cwd });
		if (result.code !== 0) throw new Error(`Invalid PR branch name: ${branch}`);
	}

	private async revParse(cwd: string, ref: string): Promise<string> {
		const result = await this.commands.run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
		if (result.code !== 0) throw new Error(`Could not resolve ${ref}: ${result.stderr.trim()}`);
		const sha = result.stdout.trim().toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git rev-parse returned an invalid SHA for ${ref}`);
		return sha;
	}
}

export function checksPassed(runs: readonly ValidationRun[]): boolean {
	return runs.length > 0 && runs.every((run) => run.code === 0);
}

export function parseGitHubRepository(remoteUrl: string): string | undefined {
	const normalized = remoteUrl.trim().replace(/\.git$/, "");
	const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(normalized);
	if (https) return `${https[1]}/${https[2]}`;
	const ssh = /^(?:ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/i.exec(normalized);
	return ssh ? `${ssh[1]}/${ssh[2]}` : undefined;
}
