import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const child = { pid: 4242 };
	const syncResult = { status: 0, stdout: "", stderr: "" };
	const nodeSpawn = vi.fn(() => child);
	const nodeSpawnSync = vi.fn(() => syncResult);
	const crossSpawn = Object.assign(
		vi.fn(() => child),
		{ sync: vi.fn(() => syncResult) },
	);
	return { child, crossSpawn, nodeSpawn, nodeSpawnSync, syncResult };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: mocks.nodeSpawn,
		spawnSync: mocks.nodeSpawnSync,
	};
});

vi.mock("cross-spawn", () => ({ default: mocks.crossSpawn }));

import { spawnProcess, spawnProcessSync } from "../src/utils/child-process.ts";

describe("background child process launchers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("always hides asynchronous subprocess windows", () => {
		const child = spawnProcess("tool", ["arg"], { stdio: "ignore", windowsHide: false });
		const spawn = process.platform === "win32" ? mocks.crossSpawn : mocks.nodeSpawn;

		expect(child).toBe(mocks.child as unknown as ChildProcess);
		expect(spawn).toHaveBeenCalledWith("tool", ["arg"], {
			stdio: "ignore",
			windowsHide: true,
		});
	});

	it("always hides synchronous subprocess windows", () => {
		const result = spawnProcessSync("tool", ["arg"], {
			encoding: "utf8",
			stdio: "pipe",
			windowsHide: false,
		});
		const spawnSync = process.platform === "win32" ? mocks.crossSpawn.sync : mocks.nodeSpawnSync;

		expect(result).toBe(mocks.syncResult);
		expect(spawnSync).toHaveBeenCalledWith("tool", ["arg"], {
			encoding: "utf8",
			stdio: "pipe",
			windowsHide: true,
		});
	});
});
