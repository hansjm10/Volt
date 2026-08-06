import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createEmptyVoltdState, parseVoltdState, VoltdStateStore } from "../src/daemon/state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.();
		},
	};
}

describe("VoltdStateStore flush serialization", () => {
	test("a delayed older writer cannot rename after and overwrite newer security state", async () => {
		const directory = await mkdtemp(join(tmpdir(), "voltd-state-flush-race-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		await writeFile(statePath, `${JSON.stringify(createEmptyVoltdState())}\n`);

		const firstWriteStarted = deferred();
		const releaseFirstWrite = deferred();
		let writeCalls = 0;
		let activeWriters = 0;
		let maximumActiveWriters = 0;
		let persistedContent = "";
		const store = new VoltdStateStore({
			agentDir: directory,
			statePath,
			debounceMs: 60_000,
			writeStateFile: async (_path, content) => {
				writeCalls++;
				activeWriters++;
				maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters);
				if (writeCalls === 1) {
					firstWriteStarted.resolve();
					await releaseFirstWrite.promise;
				}
				persistedContent = content;
				activeWriters--;
			},
		});
		await store.load();

		store.updateSettings({ themeName: "older-theme" });
		const olderFlush = store.flush();
		await firstWriteStarted.promise;

		store.updateSettings({ themeName: "newer-theme" });
		const newerFlush = store.flush();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(writeCalls).toBe(1);
		expect(maximumActiveWriters).toBe(1);
		releaseFirstWrite.resolve();
		await Promise.all([olderFlush, newerFlush]);

		expect(writeCalls).toBe(2);
		expect(maximumActiveWriters).toBe(1);
		expect(parseVoltdState(JSON.parse(persistedContent)).settings.themeName).toBe("newer-theme");
	});
});
