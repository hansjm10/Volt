import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

async function waitForDebouncedSearch(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 175);
	});
	await flushPromises();
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
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in interactive /resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).lines.join("\n");
		expect(output).toContain("ctrl+r");
		expect(output).toContain("rename");
	});

	it("does not show rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: false, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).lines.join("\n");
		expect(output).not.toContain("ctrl+r");
		expect(output).not.toContain("rename");
	});

	it("reruns an active deep search after rename refresh", async () => {
		const target = makeSession({
			id: "target",
			name: "Old",
			modified: new Date("2026-01-01T00:00:00.000Z"),
			firstMessage: "summary without the query",
		});
		const second = makeSession({
			id: "second",
			name: "Second Deep Match",
			modified: new Date("2026-01-02T00:00:00.000Z"),
			firstMessage: "another summary without the query",
		});
		let renamedName = target.name;
		let searchCalls = 0;
		const renameSession = vi.fn(async (_sessionRef: SessionInfo["ref"], nextName: string | undefined) => {
			renamedName = nextName;
		});
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async (_onProgress, query) => {
				if (query) {
					searchCalls++;
					return [{ ...target, name: renamedName }, second];
				}
				return [{ ...target, name: renamedName }, second];
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		for (const character of "deepterm") list.handleInput(character);
		await waitForDebouncedSearch();
		expect(searchCalls).toBe(1);
		expect(list.getSelectedSessionRef()?.sessionId).toBe("target");

		list.handleInput(CTRL_R);
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledWith(target.ref, "XOld");
		expect(searchCalls).toBe(2);
		expect(list.getSearchQuery()).toBe("deepterm");
		expect(list.getSelectedSessionRef()?.sessionId).toBe("target");
		const output = selector.render(120).lines.join("\n");
		expect(output).toContain("XOld");
		expect(output).toContain("Second Deep Match");
		expect(output.indexOf("XOld")).toBeLessThan(output.indexOf("Second Deep Match"));
	});

	it("enters rename mode on Ctrl+R and submits with Enter", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).lines.join("\n");
		expect(output).toContain("Rename Session");
		expect(output).not.toContain("Resume Session");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!.ref, "XOld");
	});
});
