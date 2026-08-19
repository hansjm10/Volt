import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkspaceRelativePath, WorkspaceFsError, WorkspaceRoot } from "../src/core/workspace-fs/index.ts";

const temporaryDirectories: string[] = [];
const openRoots: WorkspaceRoot[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function openWorkspace(directory = temporaryDirectory("volt-workspace-fs-")): WorkspaceRoot {
	const root = new WorkspaceRoot(directory);
	openRoots.push(root);
	return root;
}

function expectWorkspaceError(operation: string, code?: string) {
	return expect.objectContaining({
		name: "WorkspaceFsError",
		operation,
		...(code ? { code } : {}),
	});
}

async function ignoreExpectedRaceFailure<T>(operation: Promise<T>): Promise<T | undefined> {
	try {
		return await operation;
	} catch (error) {
		if (error instanceof WorkspaceFsError) return undefined;
		throw error;
	}
}

afterEach(() => {
	for (const root of openRoots.splice(0)) root.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("workspace filesystem", () => {
	it("rejects traversal, absolute, and non-portable operation paths before native dispatch", async () => {
		const root = openWorkspace();
		for (const invalid of ["", "/tmp/outside", "../outside", "a/../outside", "a//b", "a\\b", "C:/outside", "a/"]) {
			expect(() => validateWorkspaceRelativePath(invalid)).toThrow(expectWorkspaceError("validate", "EINVAL"));
			await expect(root.readFile(invalid)).rejects.toEqual(expectWorkspaceError("readFile", "EINVAL"));
		}
	});

	it("supports root metadata and sorted directory reads while refusing root deletion", async () => {
		const directory = temporaryDirectory("volt-workspace-fs-root-");
		writeFileSync(join(directory, "z"), "z");
		writeFileSync(join(directory, "a"), "a");
		const root = openWorkspace(directory);

		expect(await root.metadata(".")).toMatchObject({ type: "directory" });
		expect((await root.readDirectory(".")).map((entry) => entry.name)).toEqual(["a", "z"]);
		await expect(root.remove(".", { recursive: true })).rejects.toEqual(expectWorkspaceError("remove", "EINVAL"));
		expect(existsSync(directory)).toBe(true);
	});

	it.runIf(process.platform !== "win32")(
		"follows only relative symlinks whose dereference remains under the root",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-links-");
			const outside = temporaryDirectory("volt-workspace-fs-outside-");
			mkdirSync(join(directory, "real"));
			writeFileSync(join(directory, "real", "file.txt"), "inside");
			writeFileSync(join(outside, "file.txt"), "outside");
			symlinkSync("real", join(directory, "relative"));
			symlinkSync(outside, join(directory, "absolute"));
			symlinkSync(relative(directory, outside), join(directory, "escaping"));
			symlinkSync("missing", join(directory, "dangling"));
			const root = openWorkspace(directory);

			expect((await root.readFile("relative/file.txt")).toString()).toBe("inside");
			expect(await root.metadata("relative/file.txt")).toMatchObject({ type: "file", size: 6 });
			for (const rejected of ["absolute/file.txt", "escaping/file.txt", "dangling/file.txt"]) {
				await expect(root.readFile(rejected)).rejects.toEqual(expectWorkspaceError("readFile"));
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"lstats, renames, and deletes symlink entries without following them",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-entry-links-");
			const outside = temporaryDirectory("volt-workspace-fs-entry-outside-");
			writeFileSync(join(outside, "keep.txt"), "outside");
			symlinkSync(join(outside, "keep.txt"), join(directory, "link"));
			const root = openWorkspace(directory);

			expect(await root.lstat("link")).toMatchObject({ type: "symlink" });
			await root.rename("link", "moved-link");
			expect(lstatSync(join(directory, "moved-link")).isSymbolicLink()).toBe(true);
			await root.remove("moved-link", { recursive: true });
			expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside");
		},
	);

	it("creates files exclusively and replaces complete file contents", async () => {
		const directory = temporaryDirectory("volt-workspace-fs-create-");
		const root = openWorkspace(directory);
		await root.createFile("file.txt", Buffer.from("first"));
		await expect(root.createFile("file.txt", Buffer.from("second"))).rejects.toEqual(
			expectWorkspaceError("createFile", "EEXIST"),
		);
		await root.replaceFile("file.txt", Buffer.from("replacement"));
		expect(readFileSync(join(directory, "file.txt"), "utf8")).toBe("replacement");
	});

	it.runIf(process.platform !== "win32")(
		"replaces hard-linked files with a new inode while preserving POSIX mode",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-hard-link-");
			const target = join(directory, "target");
			const alias = join(directory, "alias");
			writeFileSync(target, "before");
			linkSync(target, alias);
			chmodSync(target, 0o4640);
			const originalInode = statSync(target).ino;
			const root = openWorkspace(directory);

			await root.replaceFile("target", Buffer.from("after"));
			expect(readFileSync(target, "utf8")).toBe("after");
			expect(readFileSync(alias, "utf8")).toBe("before");
			expect(statSync(target).ino).not.toBe(originalInode);
			expect(statSync(target).mode & 0o777).toBe(0o640);
		},
	);

	it("documents replacement metadata by replacing timestamps rather than preserving them", async () => {
		const directory = temporaryDirectory("volt-workspace-fs-metadata-");
		const target = join(directory, "target");
		writeFileSync(target, "before");
		utimesSync(target, new Date(946684800000), new Date(946684800000));
		const root = openWorkspace(directory);
		const before = await root.metadata("target");

		await root.replaceFile("target", Buffer.from("after"));
		const after = await root.metadata("target");
		expect(before.modifiedMs).toBeLessThan(1_000_000_000_000);
		expect(after.modifiedMs).toBeGreaterThan(1_500_000_000_000);
	});

	it("implements rename overwrite policy for files and directories", async () => {
		const directory = temporaryDirectory("volt-workspace-fs-rename-");
		writeFileSync(join(directory, "from"), "from");
		writeFileSync(join(directory, "to"), "to");
		mkdirSync(join(directory, "directory"));
		writeFileSync(join(directory, "directory", "child"), "child");
		const root = openWorkspace(directory);

		await expect(root.rename("from", "to")).rejects.toEqual(expectWorkspaceError("rename", "EEXIST"));
		expect(readFileSync(join(directory, "from"), "utf8")).toBe("from");
		await root.rename("from", "to", { overwrite: true });
		expect(readFileSync(join(directory, "to"), "utf8")).toBe("from");
		await root.rename("directory", "renamed-directory");
		expect(readFileSync(join(directory, "renamed-directory", "child"), "utf8")).toBe("child");
	});

	it.runIf(process.platform !== "win32")(
		"removes directories recursively without traversing nested symlinks",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-remove-");
			const outside = temporaryDirectory("volt-workspace-fs-remove-outside-");
			mkdirSync(join(directory, "tree", "nested"), { recursive: true });
			writeFileSync(join(directory, "tree", "nested", "inside"), "inside");
			writeFileSync(join(outside, "keep"), "outside");
			symlinkSync(outside, join(directory, "tree", "outside-link"));
			const root = openWorkspace(directory);

			await root.remove("tree", { recursive: true });
			expect(existsSync(join(directory, "tree"))).toBe(false);
			expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
		},
	);

	it.runIf(process.platform !== "win32")(
		"reports recursive removal failures without claiming transactionality",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-partial-");
			mkdirSync(join(directory, "tree", "locked"), { recursive: true });
			writeFileSync(join(directory, "tree", "removable"), "remove me");
			writeFileSync(join(directory, "tree", "locked", "blocked"), "blocked");
			chmodSync(join(directory, "tree", "locked"), 0o000);
			const root = openWorkspace(directory);
			try {
				await expect(root.remove("tree", { recursive: true })).rejects.toEqual(expectWorkspaceError("remove"));
			} finally {
				chmodSync(join(directory, "tree", "locked"), 0o700);
			}
			expect(existsSync(join(directory, "tree"))).toBe(true);
		},
	);

	it("lets admitted operations finish after close and rejects later operations", async () => {
		const directory = temporaryDirectory("volt-workspace-fs-disposal-");
		writeFileSync(join(directory, "large"), Buffer.alloc(16 * 1024 * 1024, 0x61));
		const root = openWorkspace(directory);
		const admitted = root.readFile("large");
		root.close();

		expect((await admitted).length).toBe(16 * 1024 * 1024);
		await expect(root.readFile("large")).rejects.toEqual(expectWorkspaceError("readFile", "ECLOSED"));
		await expect(root.dispose()).resolves.toBeUndefined();
	});

	it.runIf(process.platform !== "win32")(
		"confines every public operation while a component is repeatedly swapped with an external symlink",
		async () => {
			const directory = temporaryDirectory("volt-workspace-fs-race-");
			const outside = temporaryDirectory("volt-workspace-fs-race-outside-");
			const gate = join(directory, "gate");
			const parked = join(directory, "parked");
			mkdirSync(gate);
			writeFileSync(join(gate, "read.txt"), "inside");
			writeFileSync(join(gate, "meta.txt"), "in");
			writeFileSync(join(gate, "replace.txt"), "inside replacement");
			writeFileSync(join(gate, "rename-from"), "inside rename");
			writeFileSync(join(gate, "remove.txt"), "inside remove");
			writeFileSync(join(gate, "inside-only"), "inside");
			writeFileSync(join(outside, "read.txt"), "outside");
			writeFileSync(join(outside, "meta.txt"), "outside metadata");
			writeFileSync(join(outside, "replace.txt"), "outside replacement");
			writeFileSync(join(outside, "rename-from"), "outside rename source");
			writeFileSync(join(outside, "rename-to"), "outside rename destination");
			writeFileSync(join(outside, "remove.txt"), "outside remove");
			writeFileSync(join(outside, "outside-only"), "outside");
			const root = openWorkspace(directory);
			let stop = false;
			const toggle = async () => {
				while (!stop) {
					renameSync(gate, parked);
					symlinkSync(outside, gate);
					await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
					unlinkSync(gate);
					renameSync(parked, gate);
					await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
				}
			};
			const toggler = toggle();
			try {
				for (let index = 0; index < 60; index += 1) {
					const read = await ignoreExpectedRaceFailure(root.readFile("gate/read.txt"));
					if (read) expect(read.toString()).toBe("inside");
					const lstat = await ignoreExpectedRaceFailure(root.lstat("gate/meta.txt"));
					if (lstat) expect(lstat.size).toBe(2);
					const metadata = await ignoreExpectedRaceFailure(root.metadata("gate/meta.txt"));
					if (metadata) expect(metadata.size).toBe(2);
					const entries = await ignoreExpectedRaceFailure(root.readDirectory("gate"));
					if (entries) expect(entries.some((entry) => entry.name === "outside-only")).toBe(false);
					await ignoreExpectedRaceFailure(root.createFile(`gate/created-${index}`, Buffer.from("inside")));
					await ignoreExpectedRaceFailure(root.replaceFile("gate/replace.txt", Buffer.from("changed inside")));
					await ignoreExpectedRaceFailure(root.rename("gate/rename-from", "gate/renamed"));
					await ignoreExpectedRaceFailure(root.remove("gate/remove.txt"));
				}
			} finally {
				stop = true;
				await toggler;
			}

			expect(readFileSync(join(outside, "replace.txt"), "utf8")).toBe("outside replacement");
			expect(readFileSync(join(outside, "rename-from"), "utf8")).toBe("outside rename source");
			expect(readFileSync(join(outside, "rename-to"), "utf8")).toBe("outside rename destination");
			expect(readFileSync(join(outside, "remove.txt"), "utf8")).toBe("outside remove");
			expect(readdirSync(outside).some((name) => name.startsWith("created-"))).toBe(false);
		},
		20_000,
	);

	it("fails closed for missing, malformed, stale, or checksum-mismatched native manifests", () => {
		const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
		const sourceRoot = join(repositoryRoot, "packages", "coding-agent");
		const cases: Array<{ name: string; mutate(root: string): void }> = [
			{
				name: "missing",
				mutate(root) {
					rmSync(join(root, "native", "workspace-fs", "prebuilds", "manifest.json"));
				},
			},
			{
				name: "malformed",
				mutate(root) {
					writeFileSync(join(root, "native", "workspace-fs", "prebuilds", "manifest.json"), "not json\n");
				},
			},
			{
				name: "stale fingerprint",
				mutate(root) {
					const manifest = join(root, "native", "workspace-fs", "prebuilds", "manifest.json");
					const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
					parsed.sourceFingerprint = "0".repeat(64);
					writeFileSync(manifest, `${JSON.stringify(parsed)}\n`);
				},
			},
			{
				name: "checksum mismatch",
				mutate(root) {
					const manifestPath = join(root, "native", "workspace-fs", "prebuilds", "manifest.json");
					const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
						artifacts: Array<{ target: string; path: string }>;
					};
					const platformTarget = execFileSync(
						process.execPath,
						[join(repositoryRoot, "scripts", "workspace-fs-native.mjs"), "target"],
						{
							encoding: "utf8",
						},
					).trim();
					const artifact = parsed.artifacts.find((entry) => entry.target === platformTarget);
					if (!artifact) throw new Error(`fixture has no ${platformTarget} prebuild`);
					writeFileSync(join(root, "native", "workspace-fs", "prebuilds", artifact.path), "tampered");
				},
			},
		];

		for (const fixtureCase of cases) {
			const fixture = temporaryDirectory(`volt-workspace-fs-loader-${fixtureCase.name.replaceAll(" ", "-")}-`);
			mkdirSync(join(fixture, "src", "core"), { recursive: true });
			cpSync(join(sourceRoot, "src", "core", "workspace-fs"), join(fixture, "src", "core", "workspace-fs"), {
				recursive: true,
			});
			cpSync(
				join(sourceRoot, "native", "workspace-fs", "prebuilds"),
				join(fixture, "native", "workspace-fs", "prebuilds"),
				{
					recursive: true,
				},
			);
			fixtureCase.mutate(fixture);
			writeFileSync(
				join(fixture, "load.ts"),
				'import { WorkspaceRoot } from "./src/core/workspace-fs/index.ts"; new WorkspaceRoot(process.cwd());\n',
			);
			const result = spawnSync(process.execPath, ["--experimental-strip-types", join(fixture, "load.ts")], {
				cwd: fixture,
				encoding: "utf8",
			});
			expect(result.status, fixtureCase.name).not.toBe(0);
			expect(result.stderr, fixtureCase.name).toContain("no JavaScript mutation fallback is permitted");
		}
	});
});
