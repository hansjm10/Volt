import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionReference } from "../src/core/session-manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { createDirectorySymlinkSync } from "./symlink-utils.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		ref: overrides.ref ?? {
			sessionDirectory: "/tmp/sessions",
			storeId: "store",
			sessionGeneration: "generation-test",
			sessionId: overrides.id,
		},
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionRef: overrides.parentSessionRef,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
	};
}

function refKey(session: SessionInfo): string {
	return `${session.ref.sessionDirectory}\0${session.ref.storeId}\0${session.ref.sessionId}\0${session.ref.sessionGeneration}`;
}

function createSymlinkedSessionDirectories(): {
	baseDir: string;
	aliasA: string;
	aliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "volt-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	createDirectorySymlinkSync(sharedDir, aliasASessions);
	createDirectorySymlinkSync(sharedDir, aliasBSessions);

	return { baseDir, aliasA: aliasASessions, aliasB: aliasBSessions };
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([refKey(sessions[0]!)]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedRef: SessionReference | null = null;
		list.onDeleteSession = async (sessionRef) => {
			deletedRef = sessionRef;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([refKey(sessions[0]!)]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([refKey(sessions[0]!), null]);
		expect(deletedRef).toEqual(sessions[0]!.ref);
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).lines.join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child references use different symlink aliases", async () => {
		const paths = createSymlinkedSessionDirectories();
		tempDirs.push(paths.baseDir);
		const parentRef = {
			sessionDirectory: paths.aliasB,
			storeId: "store",
			sessionId: "parent",
			sessionGeneration: "generation-parent",
		};

		const sessions = [
			makeSession({
				id: "parent",
				ref: parentRef,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				ref: {
					sessionDirectory: paths.aliasB,
					storeId: "store",
					sessionId: "child",
					sessionGeneration: "generation-child",
				},
				parentSessionRef: {
					sessionDirectory: paths.aliasA,
					storeId: "store",
					sessionId: "parent",
					sessionGeneration: "generation-parent",
				},
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).lines.join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionDirectories();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				ref: {
					sessionDirectory: paths.aliasB,
					storeId: "store",
					sessionId: "parent",
					sessionGeneration: "generation-parent",
				},
				name: "Parent",
			}),
		];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			{
				sessionDirectory: paths.aliasA,
				storeId: "store",
				sessionId: "parent",
				sessionGeneration: "generation-parent",
			},
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
