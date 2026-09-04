import { describe, expect, it } from "vitest";
import type { SessionReference } from "../src/core/session-manager.ts";
import { SubagentRegistry } from "../src/core/subagents/registry.ts";

function registerRunning(
	registry: SubagentRegistry,
	id: string,
	options: { parentId?: string; name?: string; task?: string } = {},
): void {
	registry.register({
		id,
		...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
		agent: { name: options.name ?? "researcher", source: "built-in" },
		path: [options.name ?? "researcher"],
	});
	if (options.task !== undefined) {
		registry.setTask(id, options.task);
	}
}

describe("SubagentRegistry", () => {
	it("lists records running first, then newest first", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_first", { task: "first task" });
		registerRunning(registry, "sa_second", { task: "second task" });
		registry.complete("sa_first", "completed", { output: "first output" });
		registerRunning(registry, "sa_third", { task: "third task" });

		expect(registry.list().map((record) => record.id)).toEqual(["sa_third", "sa_second", "sa_first"]);
		expect(registry.list().map((record) => record.status)).toEqual(["running", "running", "completed"]);
	});

	it("returns bounded snapshots with an accurate total for unbounded running records", () => {
		const registry = new SubagentRegistry();
		for (let index = 0; index < 600; index += 1) {
			registerRunning(registry, `sa_${index}`);
		}

		const snapshot = registry.snapshot(25);

		expect(snapshot.total).toBe(600);
		expect(snapshot.records).toHaveLength(25);
		expect(snapshot.records.map((record) => record.id)).toEqual(
			Array.from({ length: 25 }, (_value, index) => `sa_${599 - index}`),
		);

		const preflight = registry.prepareSpawnConfirmation("large-request");
		expect(preflight.records).toHaveLength(50);
		expect(preflight.total).toBe(600);
		expect(preflight.statusCounts).toEqual({ running: 600, completed: 0, failed: 0, aborted: 0 });
	});

	it("keeps the first task and bounds long prompts", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1", { task: "x".repeat(5_000) });
		registry.setTask("sa_1", "replacement");

		const task = registry.get("sa_1")?.task;
		expect(task).toHaveLength(2_000);
		expect(task?.startsWith("xxx")).toBe(true);
		expect(task?.endsWith("…")).toBe(true);
	});

	it("atomically reserves one confirmation for concurrent identical spawn requests", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_existing", { task: "existing work" });

		const first = registry.prepareSpawnConfirmation("same-request");
		const concurrent = registry.prepareSpawnConfirmation("same-request");

		expect(first).toMatchObject({ status: "reserved", records: [{ id: "sa_existing" }] });
		expect(first.token).toBeTruthy();
		expect(concurrent).toMatchObject({ status: "pending", records: [{ id: "sa_existing" }] });
		expect(concurrent.token).toBeUndefined();
		if (!first.token) {
			throw new Error("expected confirmation token");
		}

		const lease = registry.claimSpawnConfirmation("same-request", first.token);
		expect(lease).toBeDefined();
		expect(registry.claimSpawnConfirmation("same-request", first.token)).toBeUndefined();
		expect(registry.prepareSpawnConfirmation("same-request").status).toBe("claimed");

		lease?.release();
		const afterRelease = registry.prepareSpawnConfirmation("same-request");
		expect(afterRelease.status).toBe("reserved");
		expect(afterRelease.token).not.toBe(first.token);
	});

	it("inspects and revokes exact-request confirmation state without issuing a token", () => {
		const registry = new SubagentRegistry();

		const empty = registry.inspectSpawnConfirmation("request");
		expect(empty).toMatchObject({ status: "unreserved", records: [], total: 0 });
		expect(empty.token).toBeUndefined();

		const reserved = registry.prepareSpawnConfirmation("request");
		expect(reserved.token).toBeTruthy();
		registry.cancelPendingSpawnConfirmation("request");

		const revoked = registry.inspectSpawnConfirmation("request");
		expect(revoked.status).toBe("unreserved");
		expect(revoked.token).toBeUndefined();
		expect(registry.claimSpawnConfirmation("request", reserved.token ?? "")).toBeUndefined();
	});

	it("returns completed results immediately and bounds stored output", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1", { task: "research file x" });
		registry.complete("sa_1", "completed", { output: "y".repeat(60_000) });

		const result = await registry.follow(undefined, "sa_1");
		expect(result.status).toBe("completed");
		expect(result.task).toBe("research file x");
		expect(result.output).toHaveLength(50_000);
		expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
	});

	it("bounds stored terminal errors", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1");
		registry.complete("sa_1", "failed", { error: "x".repeat(5_000) });

		const result = await registry.follow(undefined, "sa_1");
		expect(result.error).toHaveLength(4_000);
		expect(result.error?.endsWith("…")).toBe(true);
	});

	it("ignores completions after the first terminal transition", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1");
		registry.complete("sa_1", "completed", { output: "first" });
		registry.complete("sa_1", "failed", { error: "late failure" });

		const result = await registry.follow(undefined, "sa_1");
		expect(result.status).toBe("completed");
		expect(result.output).toBe("first");
		expect(result.error).toBeUndefined();
	});

	it("resolves waiting followers when the target completes", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target", { task: "long research" });

		const following = registry.follow(undefined, "sa_target");
		registry.complete("sa_target", "completed", { output: "target output" });

		await expect(following).resolves.toMatchObject({ id: "sa_target", status: "completed", output: "target output" });
	});

	it("rejects waiting followers when their signal aborts", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target");
		const controller = new AbortController();

		const following = registry.follow(undefined, "sa_target", controller.signal);
		controller.abort();

		await expect(following).rejects.toThrow(/aborted/i);
		// A later completion must not throw because the aborted waiter was removed.
		registry.complete("sa_target", "completed", { output: "done" });
	});

	it("throws for unknown run ids", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_known");
		await expect(registry.follow(undefined, "sa_missing")).rejects.toThrow(
			'Subagent run "sa_missing" is not in the delegation registry. Known runs: sa_known.',
		);
	});

	it("bounds known run ids in unknown-run errors", async () => {
		const registry = new SubagentRegistry();
		for (let index = 0; index < 30; index += 1) {
			registerRunning(registry, `sa_${index}`);
		}

		const following = registry.follow(undefined, "sa_missing");
		await expect(following).rejects.toThrow("sa_19 (10 more omitted)");
		await expect(following).rejects.not.toThrow("sa_20");
	});

	it("refuses to follow a running ancestor", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", { parentId: "sa_parent" });

		await expect(registry.follow("sa_child", "sa_parent")).rejects.toThrow("would deadlock");
	});

	it("refuses mutual follows between running siblings", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_a");
		registerRunning(registry, "sa_b");

		const firstFollow = registry.follow("sa_a", "sa_b");
		await expect(registry.follow("sa_b", "sa_a")).rejects.toThrow("would deadlock");

		registry.complete("sa_b", "completed", { output: "b output" });
		await expect(firstFollow).resolves.toMatchObject({ id: "sa_b", output: "b output" });
	});

	it("keeps a shared follow dependency active until every waiter settles", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_a");
		registerRunning(registry, "sa_b");
		const firstController = new AbortController();

		const firstFollow = registry.follow("sa_a", "sa_b", firstController.signal);
		const secondFollow = registry.follow("sa_a", "sa_b");
		firstController.abort();
		await expect(firstFollow).rejects.toThrow(/aborted/i);

		await expect(registry.follow("sa_b", "sa_a")).rejects.toThrow("would deadlock");
		registry.complete("sa_b", "completed", { output: "b output" });
		await expect(secondFollow).resolves.toMatchObject({ id: "sa_b", output: "b output" });
	});

	it("refuses follows that deadlock through a running descendant of the target", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_root-call");
		registerRunning(registry, "sa_branch", { parentId: "sa_root-call" });
		registerRunning(registry, "sa_leaf", { parentId: "sa_branch" });

		// sa_leaf waiting on sa_root-call can never resolve: sa_root-call's own
		// completion awaits sa_branch, which awaits sa_leaf.
		await expect(registry.follow("sa_leaf", "sa_root-call")).rejects.toThrow("would deadlock");
	});

	it("allows the root session to follow any running record", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target");

		const following = registry.follow(undefined, "sa_target");
		registry.complete("sa_target", "aborted");

		await expect(following).resolves.toMatchObject({ status: "aborted" });
	});

	it("evicts oldest terminal records over the cap but never running ones", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_running-oldest");
		for (let index = 0; index < 510; index += 1) {
			const id = `sa_${index}`;
			registerRunning(registry, id);
			registry.complete(id, "completed");
		}

		const records = registry.list();
		expect(records.length).toBeLessThanOrEqual(500);
		expect(records.some((record) => record.id === "sa_running-oldest")).toBe(true);
		expect(records.some((record) => record.id === "sa_0")).toBe(false);
	});

	it("evicts terminal records when a concurrent registration burst settles", () => {
		const registry = new SubagentRegistry();
		for (let index = 0; index < 510; index += 1) {
			registerRunning(registry, `sa_${index}`);
		}
		for (let index = 0; index < 510; index += 1) {
			registry.complete(`sa_${index}`, "completed");
		}

		const ids = new Set(registry.list().map((record) => record.id));
		expect(ids.size).toBe(500);
		expect(ids.has("sa_9")).toBe(false);
		expect(ids.has("sa_10")).toBe(true);
		expect(ids.has("sa_509")).toBe(true);
	});
});

describe("SubagentRegistry hydrate and claimResume", () => {
	function hydrateAborted(
		registry: SubagentRegistry,
		id: string,
		childSessionRef: SessionReference = {
			sessionDirectory: "/tmp/sessions",
			storeId: "store-1",
			sessionGeneration: "generation-test",
			sessionId: "child-1",
		},
	): void {
		registry.hydrate({
			id,
			agent: { name: "researcher" },
			path: ["researcher"],
			status: "aborted",
			error: "Interrupted before completion",
			childSessionRef,
			startedAt: 1,
			finishedAt: 2,
		});
	}

	it("claims only hydrated aborted records with a known transcript", () => {
		const registry = new SubagentRegistry();
		registry.hydrate({
			id: "sa_done",
			agent: { name: "researcher" },
			path: ["researcher"],
			status: "completed",
			output: "report",
			startedAt: 1,
			finishedAt: 2,
		});
		hydrateAborted(registry, "sa_stuck");
		registerRunning(registry, "sa_live");

		expect(registry.claimResume("sa_done")).toBeUndefined();
		expect(registry.claimResume("sa_live")).toBeUndefined();
		expect(registry.claimResume("sa_missing")).toBeUndefined();
		const claim = registry.claimResume("sa_stuck");
		expect(claim).toMatchObject({
			agentName: "researcher",
			childSessionRef: { sessionId: "child-1", storeId: "store-1" },
		});
		// Claimed: gone from the registry until re-registered or rolled back.
		expect(registry.get("sa_stuck")).toBeUndefined();
		expect(registry.claimResume("sa_stuck")).toBeUndefined();
	});

	it("rollback restores the record and is idempotent", () => {
		const registry = new SubagentRegistry();
		hydrateAborted(registry, "sa_stuck");
		const claim = registry.claimResume("sa_stuck");
		claim?.rollback();
		expect(registry.get("sa_stuck")).toMatchObject({ status: "aborted", hydrated: true });
		claim?.rollback();
		expect(registry.list().filter((record) => record.id === "sa_stuck")).toHaveLength(1);
	});

	it("rollback is a no-op once the resumed run re-registered the id", () => {
		const registry = new SubagentRegistry();
		hydrateAborted(registry, "sa_stuck");
		const claim = registry.claimResume("sa_stuck");
		registerRunning(registry, "sa_stuck");
		claim?.rollback();
		const record = registry.get("sa_stuck");
		expect(record).toMatchObject({ status: "running" });
		expect(record?.hydrated).toBeUndefined();
	});

	it("register throws on a live duplicate id", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_live");
		expect(() => registerRunning(registry, "sa_live")).toThrow(/already registered/);
	});
});
