import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CanonicalCodeHostRepository,
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestDiscoveryRequest,
} from "../src/core/code-host/types.ts";
import { isExactTuiWorkObservationLeaseHolder } from "../src/daemon/iroh-service.ts";
import { WorkAssociationService } from "../src/daemon/work-association.ts";
import { parseWorkState, WORK_STATE_MAX_REPOSITORIES, WorkStateStore } from "../src/daemon/work-state.ts";

const OID_A = "0123456789abcdef0123456789abcdef01234567";
const OID_B = "abcdef0123456789abcdef0123456789abcdef01";
const tempDirectories: string[] = [];

function tempDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${label}-`));
	tempDirectories.push(directory);
	return directory;
}

function statePath(label: string): string {
	return join(tempDirectory(label), "daemon", "work-state.json");
}

function repository(owner: string, name: string): CanonicalCodeHostRepository {
	return {
		providerId: "github",
		host: "github.com",
		owner,
		name,
		canonicalId: `github:github.com/${owner}/${name}`,
	};
}

function resolved(
	number = 42,
	status: "open" | "draft" | "merged" | "closed" = "open",
): Extract<CodeHostPullRequestDiscoveryOutcome, { state: "resolved" }> {
	return {
		state: "resolved",
		pullRequest: {
			providerId: "github",
			repository: repository("volt-hq", "volt"),
			headRepository: repository("contributor", "fork"),
			number,
			title: `PR ${number}`,
			status,
			headBranch: "feature/work",
			matchedHeadOid: OID_A,
		},
	};
}

class FakeDiscoveryProvider implements CodeHostPullRequestDiscoveryProvider {
	readonly id = "fake";
	readonly requests: CodeHostPullRequestDiscoveryRequest[] = [];
	outcome: CodeHostPullRequestDiscoveryOutcome = { state: "none" };
	resolver?: (request: CodeHostPullRequestDiscoveryRequest) => Promise<CodeHostPullRequestDiscoveryOutcome>;
	active = 0;
	maxActive = 0;

	async discoverPullRequest(
		request: CodeHostPullRequestDiscoveryRequest,
	): Promise<CodeHostPullRequestDiscoveryOutcome> {
		this.requests.push(request);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			return this.resolver ? await this.resolver(request) : this.outcome;
		} finally {
			this.active--;
		}
	}
}

function observation(
	overrides: Partial<{
		workspaceName: string;
		workspaceGeneration: number;
		sessionId: string;
		cwd: string;
		commonGitDir: string;
		repositoryDisplayName: string;
		branch: string;
		headOid: string;
		trusted: boolean;
		baseBranches: readonly string[];
	}> = {},
) {
	return {
		workspaceName: overrides.workspaceName ?? "volt",
		workspaceGeneration: overrides.workspaceGeneration ?? 1,
		sessionId: overrides.sessionId ?? "session-a",
		cwd: overrides.cwd ?? "/workspace/volt",
		commonGitDir: overrides.commonGitDir ?? "/workspace/volt/.git",
		repositoryDisplayName: overrides.repositoryDisplayName ?? "Volt",
		branch: overrides.branch ?? "feature/work",
		headOid: overrides.headOid ?? OID_A,
		trusted: overrides.trusted ?? true,
		...(overrides.baseBranches === undefined ? {} : { baseBranches: overrides.baseBranches }),
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(() => {
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("WorkStateStore", () => {
	it("persists owner-only bounded state without checkout paths and reloads it", async () => {
		const path = statePath("work-state-reload");
		const store = new WorkStateStore({ path });
		await store.load();
		const binding = await store.bindObservation({
			...observation(),
			baseBranch: false,
			now: 100,
		});
		await store.applyDiscovery(
			binding.fence,
			{
				state: "resolved",
				pullRequest: {
					provider: "github",
					number: 42,
					title: "Exact PR",
					status: "open",
					matchedHeadOid: OID_A,
				},
			},
			{ now: 101, nextRefreshAt: 1000, refreshSucceeded: true },
		);
		await store.close();

		expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const serialized = readFileSync(path, "utf8");
		expect(serialized).not.toContain("/workspace/volt");
		expect(serialized).not.toContain(".git");
		expect(serialized).not.toContain("github:github.com");

		const reopened = new WorkStateStore({ path });
		await reopened.load();
		expect(reopened.getWorkContext("volt", 1, "session-a", 200)).toMatchObject({
			changeId: binding.change.id,
			repository: "Volt",
			branch: "feature/work",
			resolutionState: "resolved",
			pullRequest: { number: 42, title: "Exact PR", stale: false },
		});
		await reopened.close();
	});

	it("backs up malformed and oversized state and regenerates a strict empty file", async () => {
		const path = statePath("work-state-corrupt");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{malformed", { mode: 0o666 });
		chmodSync(path, 0o666);
		let now = 123;
		const store = new WorkStateStore({ path, now: () => now });
		const loaded = await store.load();
		expect(loaded.corruptBackupPath).toBe(`${path}.corrupt-123`);
		expect(loaded.state.repositories).toEqual([]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(() =>
			parseWorkState({
				...loaded.state,
				repositories: Array.from({ length: WORK_STATE_MAX_REPOSITORIES + 1 }, () => ({})),
			}),
		).toThrow(/invalid|unsupported/i);
		now++;
		await store.close();
	});

	it("shares feature changes, isolates base branches, and rebinds unresolved branch moves", async () => {
		const store = new WorkStateStore({ path: statePath("work-state-binding") });
		await store.load();
		const featureA = await store.bindObservation({ ...observation({ sessionId: "a" }), baseBranch: false, now: 1 });
		const featureB = await store.bindObservation({ ...observation({ sessionId: "b" }), baseBranch: false, now: 2 });
		expect(featureB.change.id).toBe(featureA.change.id);

		const baseA = await store.bindObservation({
			...observation({ sessionId: "base-a", branch: "main" }),
			baseBranch: true,
			now: 3,
		});
		const baseB = await store.bindObservation({
			...observation({ sessionId: "base-b", branch: "main" }),
			baseBranch: true,
			now: 4,
		});
		expect(baseB.change.id).not.toBe(baseA.change.id);

		const moved = await store.bindObservation({
			...observation({ sessionId: "a", branch: "feature/moved", headOid: OID_B }),
			baseBranch: false,
			now: 5,
		});
		expect(moved.change.id).not.toBe(featureA.change.id);
		expect(moved.binding.bindingGeneration).toBe(2);
		await store.close();
	});
});

describe("TUI Work observation authority", () => {
	it("accepts only the exact TUI connection holding the session lease", () => {
		const lease = { state: "tui-owned" as const, tuiConnectionId: "connection-a" };
		expect(isExactTuiWorkObservationLeaseHolder({ client: "tui", connectionId: "connection-a" }, lease)).toBe(true);
		expect(isExactTuiWorkObservationLeaseHolder({ client: "tui", connectionId: "connection-b" }, lease)).toBe(false);
		expect(isExactTuiWorkObservationLeaseHolder({ client: "cli", connectionId: "connection-a" }, lease)).toBe(false);
		expect(
			isExactTuiWorkObservationLeaseHolder(
				{ client: "tui", connectionId: "connection-a" },
				{ state: "daemon-active", tuiConnectionId: "connection-a" },
			),
		).toBe(false);
	});
});

describe("WorkAssociationService", () => {
	it("keeps an exact positive association sticky across checkout changes and branch reuse", async () => {
		let now = 100;
		const store = new WorkStateStore({ path: statePath("work-sticky"), now: () => now });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		provider.outcome = resolved(42);
		const service = new WorkAssociationService({ store, discoveryProvider: provider, now: () => now });
		await service.observe(observation());
		const initial = service.getWorkContext("volt", 1, "session-a")!;
		expect(initial).toMatchObject({ branch: "feature/work", pullRequest: { number: 42 } });

		now++;
		await service.observe(observation({ branch: "main", headOid: OID_B }));
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			changeId: initial.changeId,
			branch: "feature/work",
			pullRequest: { number: 42 },
		});
		expect(provider.requests).toHaveLength(1);

		now++;
		provider.outcome = resolved(99);
		await service.observe(observation({ sessionId: "session-reuse", headOid: OID_B }));
		expect(service.getWorkContext("volt", 1, "session-reuse")).toMatchObject({
			changeId: initial.changeId,
			pullRequest: { number: 42 },
		});
		await service.close();
	});

	it("fences delayed discovery by session binding generation, repository, branch, and OID", async () => {
		const store = new WorkStateStore({ path: statePath("work-cas") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const resolvers = new Map<string, (outcome: CodeHostPullRequestDiscoveryOutcome) => void>();
		provider.resolver = (request) => new Promise((resolve) => resolvers.set(request.branch, resolve));
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		const first = service.observe(observation());
		await waitFor(() => resolvers.has("feature/work"));
		const second = service.observe(observation({ branch: "feature/new", headOid: OID_B }));
		await waitFor(() => resolvers.has("feature/new"));
		resolvers.get("feature/work")!({
			state: "resolved",
			pullRequest: { ...resolved(1).pullRequest!, headBranch: "feature/work" },
		});
		resolvers.get("feature/new")!({ state: "none" });
		await Promise.all([first, second]);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			branch: "feature/new",
			resolutionState: "none",
		});
		await service.close();
	});

	it("deduplicates in-flight and cached discovery and enforces provider concurrency", async () => {
		const store = new WorkStateStore({ path: statePath("work-dedupe") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const pending: Array<(outcome: CodeHostPullRequestDiscoveryOutcome) => void> = [];
		provider.resolver = () => new Promise((resolve) => pending.push(resolve));
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			providerConcurrency: 1,
		});
		const first = service.observe(observation({ sessionId: "first" }));
		const second = service.observe(observation({ sessionId: "second" }));
		await waitFor(() => provider.requests.length === 1);
		expect(provider.maxActive).toBe(1);
		pending.shift()!({ state: "none" });
		await Promise.all([first, second]);
		expect(provider.requests).toHaveLength(1);

		await service.observe(observation({ sessionId: "third" }));
		expect(provider.requests).toHaveLength(1);

		const branchA = service.observe(observation({ sessionId: "a", branch: "feature/a", headOid: OID_A }));
		const branchB = service.observe(observation({ sessionId: "b", branch: "feature/b", headOid: OID_B }));
		await waitFor(() => provider.requests.length === 2);
		expect(provider.active).toBe(1);
		pending.shift()!({ state: "none" });
		await waitFor(() => provider.requests.length === 3);
		expect(provider.maxActive).toBe(1);
		pending.shift()!({ state: "none" });
		await Promise.all([branchA, branchB]);
		await service.close();
	});

	it("uses unavailable state and backoff while offline, disabled, or untrusted without provider calls", async () => {
		let now = 1000;
		const store = new WorkStateStore({ path: statePath("work-offline"), now: () => now });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			now: () => now,
			isOnline: () => false,
		});
		await service.observe(observation());
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({ resolutionState: "unavailable" });
		expect(provider.requests).toEqual([]);
		now++;
		await service.observe(observation());
		expect(provider.requests).toEqual([]);
		await service.close();

		const disabledStore = new WorkStateStore({ path: statePath("work-disabled") });
		await disabledStore.load();
		const disabled = new WorkAssociationService({
			store: disabledStore,
			discoveryProvider: provider,
			enabled: false,
		});
		await disabled.observe(observation({ sessionId: "disabled" }));
		await disabled.close();

		const untrustedStore = new WorkStateStore({ path: statePath("work-untrusted") });
		await untrustedStore.load();
		const untrusted = new WorkAssociationService({ store: untrustedStore, discoveryProvider: provider });
		await untrusted.observe(observation({ sessionId: "untrusted", trusted: false }));
		await untrusted.close();
		expect(provider.requests).toEqual([]);
	});

	it("keeps repositories distinct by registered workspace generation and common Git directory", async () => {
		const store = new WorkStateStore({ path: statePath("work-repositories") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		await service.observe(observation({ sessionId: "root", cwd: "/workspace/root" }));
		await service.observe(
			observation({
				sessionId: "worktree",
				cwd: "/workspace/worktree",
				commonGitDir: "/workspace/volt/.git",
			}),
		);
		expect(service.getWorkContext("volt", 1, "root")?.changeId).toBe(
			service.getWorkContext("volt", 1, "worktree")?.changeId,
		);
		await service.observe(
			observation({
				workspaceGeneration: 2,
				sessionId: "replacement",
				cwd: "/workspace/root",
			}),
		);
		expect(service.getWorkContext("volt", 2, "replacement")?.changeId).not.toBe(
			service.getWorkContext("volt", 1, "root")?.changeId,
		);
		await service.close();
	});
});
