import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";
import { runGitHubCli } from "./github-cli.ts";
import type {
	CanonicalCodeHostRepository,
	CodeHostPullRequestAssociation,
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestDiscoveryRequest,
	CodeHostPullRequestDiscoveryUnavailableReason,
} from "./types.ts";

const MAX_REMOTES = 16;
const MAX_REPOSITORIES = 8;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_GH_OUTPUT_BYTES = 256 * 1024;
const MAX_BRANCH_CHARS = 1024;
const MAX_TITLE_CHARS = 512;
const GIT_TIMEOUT_MS = 2500;
const GH_TIMEOUT_MS = 15_000;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_NAME_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

interface GitCommandResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly failure: "exit" | "spawn" | "timeout" | "output" | "cancelled" | null;
}

interface RemoteRepository {
	readonly remote: string;
	readonly repository: CanonicalCodeHostRepository;
}

function createGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CEILING_DIRECTORIES",
		"GIT_CONFIG",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_COUNT",
	]) {
		delete environment[key];
	}
	for (const key of Object.keys(environment)) {
		if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete environment[key];
	}
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_PAGER = "cat";
	environment.LC_ALL = "C";
	return environment;
}

function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ ok: false, stdout: "", failure: "cancelled" });
			return;
		}
		const child: ChildProcess = spawnProcess("git", [...args], {
			cwd,
			env: createGitEnvironment(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let byteCount = 0;
		let failure: GitCommandResult["failure"] = null;
		let settled = false;
		const terminate = (): void => {
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const timeout = setTimeout(() => {
			if (failure === null) failure = "timeout";
			terminate();
		}, GIT_TIMEOUT_MS);
		timeout.unref?.();
		const onAbort = (): void => {
			if (failure === null) failure = "cancelled";
			terminate();
		};
		const finish = (result: GitCommandResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failure !== null) return;
			byteCount += chunk.length;
			if (byteCount > MAX_GIT_OUTPUT_BYTES) {
				failure = "output";
				terminate();
				return;
			}
			chunks.push(chunk);
		});
		child.once("error", () => {
			failure = "spawn";
			finish({ ok: false, stdout: "", failure });
		});
		child.once("close", (code) => {
			const finalFailure = failure ?? (code === 0 ? null : "exit");
			finish({
				ok: finalFailure === null,
				stdout: finalFailure === null ? Buffer.concat(chunks, byteCount).toString("utf8") : "",
				failure: finalFailure,
			});
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function normalizedRepository(host: string, owner: string, name: string): CanonicalCodeHostRepository | null {
	const normalizedHost = host.trim().toLowerCase();
	const normalizedOwner = owner.trim().toLowerCase();
	const normalizedName = name
		.trim()
		.replace(/\.git$/i, "")
		.toLowerCase();
	if (
		!normalizedHost ||
		normalizedHost.length > 253 ||
		!normalizedOwner ||
		normalizedOwner.length > 100 ||
		!normalizedName ||
		normalizedName.length > 100 ||
		![normalizedHost, normalizedOwner, normalizedName].every((part) => !/[\0-\x20\x7f]/.test(part)) ||
		normalizedOwner.includes("/") ||
		normalizedName.includes("/")
	) {
		return null;
	}
	return Object.freeze({
		providerId: "github",
		host: normalizedHost,
		owner: normalizedOwner,
		name: normalizedName,
		canonicalId: `github:${normalizedHost}/${normalizedOwner}/${normalizedName}`,
	});
}

/** Parse ordinary GitHub and GHES HTTPS/SSH remote forms without retaining credentials. */
export function canonicalizeGitHubRemoteUrl(value: string): CanonicalCodeHostRepository | null {
	const trimmed = value.trim();
	if (!trimmed || /[\0\r\n]/.test(trimmed)) return null;

	const scp = /^(?:git@)?([^:/\s]+):([^/\s]+)\/(.+)$/.exec(trimmed);
	if (scp?.[1] && scp[2] && scp[3]) return normalizedRepository(scp[1], scp[2], scp[3]);

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (!url.hostname || url.search || url.hash || (url.username && url.username !== "git") || url.password) return null;
	if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return null;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
	return normalizedRepository(url.host, segments[0], segments[1]);
}

function repositorySlug(repository: CanonicalCodeHostRepository): string {
	const path = `${repository.owner}/${repository.name}`;
	return repository.host === "github.com" ? path : `${repository.host}/${path}`;
}

async function discoverRemoteRepositories(
	request: CodeHostPullRequestDiscoveryRequest,
): Promise<RemoteRepository[] | CodeHostPullRequestDiscoveryOutcome> {
	const remotesResult = await runGit(["remote"], request.cwd, request.signal);
	if (!remotesResult.ok) {
		return {
			state: "unavailable",
			reason: remotesResult.failure === "cancelled" ? "cancelled" : "provider_error",
		};
	}
	const remoteNames = remotesResult.stdout
		.split(/\r?\n/)
		.map((name) => name.trim())
		.filter((name) => REMOTE_NAME_PATTERN.test(name))
		.slice(0, MAX_REMOTES);
	const repositories: RemoteRepository[] = [];
	for (const remote of remoteNames) {
		const urls = await runGit(["remote", "get-url", "--all", remote], request.cwd, request.signal);
		if (!urls.ok) {
			if (urls.failure === "cancelled") return { state: "unavailable", reason: "cancelled" };
			continue;
		}
		for (const line of urls.stdout.split(/\r?\n/)) {
			const repository = canonicalizeGitHubRemoteUrl(line);
			if (repository) repositories.push({ remote, repository });
		}
	}
	return repositories;
}

function remoteForTrackingRef(ref: string, remotes: readonly RemoteRepository[], branch: string): string | null {
	const expectedSuffix = `/${branch}`;
	if (!ref.endsWith(expectedSuffix)) return null;
	const remote = remotes
		.map((candidate) => candidate.remote)
		.sort((left, right) => right.length - left.length)
		.find((candidate) => ref === `${candidate}/${branch}`);
	return remote ?? null;
}

async function selectHeadRepository(
	request: CodeHostPullRequestDiscoveryRequest,
	remotes: readonly RemoteRepository[],
): Promise<CanonicalCodeHostRepository | CodeHostPullRequestDiscoveryOutcome> {
	const candidates = new Map<string, CanonicalCodeHostRepository>();
	const addRemote = (remote: string | null): void => {
		if (!remote) return;
		for (const candidate of remotes) {
			if (candidate.remote === remote) candidates.set(candidate.repository.canonicalId, candidate.repository);
		}
	};

	const upstream = await runGit(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		request.cwd,
		request.signal,
	);
	if (upstream.failure === "cancelled") return { state: "unavailable", reason: "cancelled" };
	if (upstream.ok) addRemote(remoteForTrackingRef(upstream.stdout.trim(), remotes, request.branch));

	if (candidates.size === 0) {
		const refs = await runGit(
			["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/remotes"],
			request.cwd,
			request.signal,
		);
		if (refs.failure === "cancelled") return { state: "unavailable", reason: "cancelled" };
		if (!refs.ok && refs.failure !== "exit") return { state: "unavailable", reason: "provider_error" };
		for (const line of refs.stdout.split(/\r?\n/)) {
			const [ref, oid] = line.split("\0");
			if (!ref || oid?.toLowerCase() !== request.headOid) continue;
			const shortRef = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : "";
			addRemote(remoteForTrackingRef(shortRef, remotes, request.branch));
		}
	}

	if (candidates.size === 0) {
		for (const candidate of remotes) candidates.set(candidate.repository.canonicalId, candidate.repository);
	}
	if (candidates.size !== 1) return { state: "unavailable", reason: "repository_ambiguous" };
	return candidates.values().next().value!;
}

function unavailableReason(
	stderr: string,
	outputLimited: boolean,
	timedOut: boolean,
): CodeHostPullRequestDiscoveryUnavailableReason {
	if (outputLimited) return "output_limited";
	if (timedOut) return "timeout";
	const normalized = stderr.toLowerCase();
	if (/auth|login|credential|token/.test(normalized)) return "not_authenticated";
	if (/rate.?limit|secondary limit|abuse detection/.test(normalized)) return "rate_limited";
	if (/network|connection|resolve host|timed? out|tls|socket/.test(normalized)) return "network";
	return "provider_error";
}

function parsePullRequests(
	text: string,
	baseRepository: CanonicalCodeHostRepository,
	headRepository: CanonicalCodeHostRepository,
	branch: string,
	headOid: string,
): CodeHostPullRequestAssociation[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length > 100) return null;
	const matches: CodeHostPullRequestAssociation[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
		const value = item as Record<string, unknown>;
		const headRepositoryValue = value.headRepository;
		const headOwnerValue = value.headRepositoryOwner;
		const headRepositoryObject =
			typeof headRepositoryValue === "object" && headRepositoryValue !== null && !Array.isArray(headRepositoryValue)
				? (headRepositoryValue as Record<string, unknown>)
				: null;
		const headOwnerObject =
			typeof headOwnerValue === "object" && headOwnerValue !== null && !Array.isArray(headOwnerValue)
				? (headOwnerValue as Record<string, unknown>)
				: null;
		const nameWithOwner =
			typeof headRepositoryObject?.nameWithOwner === "string"
				? headRepositoryObject.nameWithOwner
				: typeof headRepositoryObject?.name === "string" && typeof headOwnerObject?.login === "string"
					? `${headOwnerObject.login}/${headRepositoryObject.name}`
					: null;
		const headParts = nameWithOwner?.split("/") ?? [];
		const canonicalHead =
			headParts.length === 2 && headParts[0] && headParts[1]
				? normalizedRepository(baseRepository.host, headParts[0], headParts[1])
				: null;
		if (
			typeof value.number !== "number" ||
			!Number.isSafeInteger(value.number) ||
			value.number < 1 ||
			typeof value.title !== "string" ||
			typeof value.state !== "string" ||
			typeof value.isDraft !== "boolean" ||
			typeof value.headRefName !== "string" ||
			typeof value.headRefOid !== "string" ||
			!canonicalHead
		) {
			return null;
		}
		if (
			canonicalHead.canonicalId !== headRepository.canonicalId ||
			value.headRefName !== branch ||
			value.headRefOid.toLowerCase() !== headOid
		) {
			continue;
		}
		const state = value.state.toUpperCase();
		const status =
			state === "OPEN"
				? value.isDraft
					? "draft"
					: "open"
				: state === "MERGED"
					? "merged"
					: state === "CLOSED"
						? "closed"
						: null;
		if (!status) return null;
		matches.push({
			providerId: "github",
			repository: baseRepository,
			headRepository,
			number: value.number,
			title: value.title.slice(0, MAX_TITLE_CHARS),
			status,
			headBranch: branch,
			matchedHeadOid: headOid,
		});
	}
	return matches;
}

export async function discoverPullRequestWithGitHubCli(
	request: CodeHostPullRequestDiscoveryRequest,
): Promise<CodeHostPullRequestDiscoveryOutcome> {
	const branch = request.branch.trim();
	const headOid = request.headOid.toLowerCase();
	if (!branch || branch.length > MAX_BRANCH_CHARS || /[\0\r\n]/.test(branch) || !OID_PATTERN.test(headOid)) {
		return { state: "unavailable", reason: "invalid_response" };
	}
	if (request.signal?.aborted) return { state: "unavailable", reason: "cancelled" };

	const discovered = await discoverRemoteRepositories({ ...request, branch, headOid });
	if (!Array.isArray(discovered)) return discovered;
	if (discovered.length === 0) return { state: "unavailable", reason: "unsupported_repository" };
	const headRepository = await selectHeadRepository({ ...request, branch, headOid }, discovered);
	if ("state" in headRepository) return headRepository;

	const repositories = new Map<string, CanonicalCodeHostRepository>();
	for (const candidate of discovered) repositories.set(candidate.repository.canonicalId, candidate.repository);
	if (repositories.size > MAX_REPOSITORIES) return { state: "unavailable", reason: "repository_ambiguous" };

	const matches = new Map<string, CodeHostPullRequestAssociation>();
	try {
		for (const repository of repositories.values()) {
			const result = await runGitHubCli(
				[
					"pr",
					"list",
					"--repo",
					repositorySlug(repository),
					"--state",
					"all",
					"--head",
					branch,
					"--limit",
					"100",
					"--json",
					"number,title,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner",
				],
				{
					cwd: request.cwd,
					...(request.signal === undefined ? {} : { signal: request.signal }),
					stdoutMaxBytes: MAX_GH_OUTPUT_BYTES,
					stderrMaxBytes: 32 * 1024,
					timeoutMs: GH_TIMEOUT_MS,
					cancellationMessage: "GitHub pull request discovery was cancelled.",
				},
			);
			if (!result.ok) {
				return {
					state: "unavailable",
					reason: unavailableReason(result.stderr, result.outputLimited, result.timedOut),
				};
			}
			const repositoryMatches = parsePullRequests(
				result.stdout.toString("utf8"),
				repository,
				headRepository,
				branch,
				headOid,
			);
			if (!repositoryMatches) return { state: "unavailable", reason: "invalid_response" };
			for (const match of repositoryMatches) {
				matches.set(`${match.repository.canonicalId}#${match.number}`, match);
			}
		}
	} catch {
		return {
			state: "unavailable",
			reason: request.signal?.aborted ? "cancelled" : "provider_error",
		};
	}

	const candidates = [...matches.values()];
	const active = candidates.filter((candidate) => candidate.status === "open" || candidate.status === "draft");
	if (active.length === 1) return { state: "resolved", pullRequest: active[0]! };
	if (active.length > 1) return { state: "ambiguous" };
	const historical = candidates.filter((candidate) => candidate.status === "merged" || candidate.status === "closed");
	if (historical.length === 1) return { state: "resolved", pullRequest: historical[0]! };
	if (historical.length > 1) return { state: "ambiguous" };
	return { state: "none" };
}

export const githubCliPullRequestDiscoveryProvider: CodeHostPullRequestDiscoveryProvider = {
	id: "github",
	discoverPullRequest: discoverPullRequestWithGitHubCli,
};
