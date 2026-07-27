/**
 * Stall detection for the bash tool (#125).
 *
 * A wall-clock timeout cannot distinguish a hung command from a slow one, so it
 * has to be set generously and the excess becomes dead wall time. These tests
 * cover the silence-based deadline that replaces that guess.
 */
import { describe, expect, test } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";

const ctx = {} as never;

describe("bash stall detection", () => {
	test("kills a command that goes silent and explains why", async () => {
		const tool = createBashToolDefinition(process.cwd());
		await expect(
			tool.execute("stall-1", { command: "sleep 30", stallTimeout: 1 }, undefined, undefined, ctx),
		).rejects.toThrow(/produced no output for 1 seconds and was killed as hung/);
	}, 15000);

	test("leaves a slow but talking command alone past the stall window", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// ~2s total runtime, but never silent for more than ~0.3s.
		const result = await tool.execute(
			"stall-2",
			{ command: "for i in 1 2 3 4 5 6 7; do echo tick; sleep 0.3; done", stallTimeout: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(JSON.stringify(result)).toContain("tick");
	}, 15000);

	// Paired against the identical command with a live deadline, so this cannot
	// pass merely because the command was short enough to finish.
	test("an explicit stallTimeout of 0 disables the deadline", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// The silence must outrun the 1s deadline by a wide margin: with a thin
		// gap, event-loop starvation from a parallel worker lets `echo` land first
		// and re-arm the timer, failing the kill case spuriously.
		const silent = "sleep 4; echo done";

		await expect(
			tool.execute("stall-3a", { command: silent, stallTimeout: 1 }, undefined, undefined, ctx),
		).rejects.toThrow(/killed as hung/);

		const result = await tool.execute("stall-3b", { command: silent, stallTimeout: 0 }, undefined, undefined, ctx);
		expect(JSON.stringify(result)).toContain("done");
	}, 20000);

	test("a malformed stallTimeout falls back to the default instead of disabling", async () => {
		const tool = createBashToolDefinition(process.cwd());
		// -1 must not be read as "disable"; with the default deadline in force a
		// 1.5s silent command still completes normally.
		const result = await tool.execute(
			"stall-3c",
			{ command: "sleep 1.5; echo done", stallTimeout: -1 },
			undefined,
			undefined,
			ctx,
		);
		expect(JSON.stringify(result)).toContain("done");
	}, 20000);

	test("a caller abort is reported as an abort, not as a stall", async () => {
		const tool = createBashToolDefinition(process.cwd());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		await expect(
			tool.execute("stall-4", { command: "sleep 30", stallTimeout: 1 }, controller.signal, undefined, ctx),
		).rejects.toThrow(/Command aborted/);
	}, 15000);

	// The opposite ordering: the stall fires first, then the run is torn down
	// before the error surfaces. Reading signal.aborted at catch time would
	// report a plain abort here and hide the hang, so the model would retry it.
	test("reports a stall even when the caller aborts before the error surfaces", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { signal: execSignal }) => {
				await new Promise<void>((resolve) => {
					execSignal?.addEventListener("abort", () => resolve(), { once: true });
				});
				controller.abort();
				throw new Error("aborted");
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		await expect(
			tool.execute("stall-5", { command: "hang", stallTimeout: 1 }, controller.signal, undefined, ctx),
		).rejects.toThrow(/killed as hung/);
	}, 15000);
});

describe("bash timeout normalization", () => {
	function capturingOps(): { ops: BashOperations; seen: Array<number | undefined> } {
		const seen: Array<number | undefined> = [];
		return {
			seen,
			ops: {
				exec: async (_command, _cwd, { timeout }) => {
					seen.push(timeout);
					return { exitCode: 0 };
				},
			},
		};
	}

	test("clamps an over-large wall-clock timeout to the maximum", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-1", { command: "true", timeout: 99999 }, undefined, undefined, ctx);
		expect(seen).toEqual([3600]);
	});

	test("passes through an omitted timeout unchanged", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-2", { command: "true" }, undefined, undefined, ctx);
		expect(seen).toEqual([undefined]);
	});

	test("drops a non-positive wall-clock timeout instead of arming a zero timer", async () => {
		const { ops, seen } = capturingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops });
		await tool.execute("clamp-3", { command: "true", timeout: 0 }, undefined, undefined, ctx);
		expect(seen).toEqual([undefined]);
	});
});
