import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import type { SessionManager, SessionReference } from "../src/core/session-manager.ts";
import { formatResumeCommand } from "../src/modes/interactive/interactive-mode.ts";

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
});

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function createSessionManager(options: {
	persisted?: boolean;
	hasSessionRef?: boolean;
	sessionId?: string;
	sessionDir?: string;
	usesDefaultSessionDir?: boolean;
}): SessionManager {
	const sessionId = options.sessionId ?? "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
	const sessionDirectory = options.sessionDir ?? "/tmp/volt-sessions";
	const sessionRef: SessionReference = Object.freeze({
		sessionDirectory,
		storeId: "store-test",
		sessionId,
		sessionGeneration: "generation-test",
	});
	return {
		isPersisted: () => options.persisted ?? true,
		getSessionRef: () => (options.hasSessionRef === false ? undefined : sessionRef),
		getSessionId: () => sessionId,
		getSessionDir: () => sessionDirectory,
		usesDefaultSessionDir: () => options.usesDefaultSessionDir ?? true,
	} as unknown as SessionManager;
}

describe("formatResumeCommand", () => {
	it("returns a session resume command for default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ sessionId: "test-session" });

		expect(formatResumeCommand(sessionManager)).toBe(`${APP_NAME} --session test-session`);
	});

	it("includes unquoted safe session dirs for non-default session dirs", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({
			sessionId: "test-session",
			sessionDir: "/tmp/custom-volt-sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir /tmp/custom-volt-sessions --session test-session`,
		);
	});

	it("quotes session dirs containing spaces", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({
			sessionId: "test-session",
			sessionDir: "/tmp/custom volt sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom volt sessions' --session test-session`,
		);
	});

	it("quotes session dirs containing single quotes", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({
			sessionId: "test-session",
			sessionDir: "/tmp/custom volt's sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(sessionManager)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom volt'\\''s sessions' --session test-session`,
		);
	});

	it("returns undefined when stdout is not a TTY", () => {
		setStdoutIsTTY(false);
		const sessionManager = createSessionManager({});

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined for in-memory sessions", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ persisted: false });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});

	it("returns undefined when a persisted manager has no session reference", () => {
		setStdoutIsTTY(true);
		const sessionManager = createSessionManager({ hasSessionRef: false });

		expect(formatResumeCommand(sessionManager)).toBeUndefined();
	});
});
