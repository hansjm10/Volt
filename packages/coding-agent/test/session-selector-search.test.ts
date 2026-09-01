import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

function makeSession(overrides: Partial<SessionInfo> & { id: string; modified: Date }): SessionInfo {
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
		modified: overrides.modified,
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "(no messages)",
	};
}

describe("session selector search", () => {
	it("filters by quoted phrase with whitespace normalization", () => {
		const sessions = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "node\n\n   cve was discussed",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "node something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"node cve"', "recent");
		expect(result.map((session) => session.id)).toEqual(["a"]);
	});

	it("filters by regex and is case-insensitive", () => {
		const sessions = [
			makeSession({
				id: "a",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "Brave is great",
			}),
			makeSession({
				id: "b",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "bravery is not the same",
			}),
		];

		const result = filterAndSortSessions(sessions, "re:\\bbrave\\b", "recent");
		expect(result.map((session) => session.id)).toEqual(["a"]);
	});

	it("recent sort preserves input order", () => {
		const sessions = [
			makeSession({ id: "newer", modified: new Date("2026-01-03T00:00:00.000Z"), firstMessage: "brave" }),
			makeSession({ id: "older", modified: new Date("2026-01-01T00:00:00.000Z"), firstMessage: "brave" }),
			makeSession({
				id: "nomatch",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				firstMessage: "something else",
			}),
		];

		const result = filterAndSortSessions(sessions, '"brave"', "recent");
		expect(result.map((session) => session.id)).toEqual(["newer", "older"]);
	});

	it("relevance sort orders by score and tie-breaks by modified desc", () => {
		const sessions = [
			makeSession({ id: "late", modified: new Date("2026-01-03T00:00:00.000Z"), firstMessage: "xxxx brave" }),
			makeSession({ id: "early", modified: new Date("2026-01-01T00:00:00.000Z"), firstMessage: "brave xxxx" }),
		];

		expect(filterAndSortSessions(sessions, '"brave"', "relevance").map((session) => session.id)).toEqual([
			"early",
			"late",
		]);

		const tieSessions = [
			makeSession({ id: "newer", modified: new Date("2026-01-03T00:00:00.000Z"), firstMessage: "brave" }),
			makeSession({ id: "older", modified: new Date("2026-01-01T00:00:00.000Z"), firstMessage: "brave" }),
		];
		expect(filterAndSortSessions(tieSessions, '"brave"', "relevance").map((session) => session.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("returns an empty list for invalid regex", () => {
		const sessions = [
			makeSession({ id: "a", modified: new Date("2026-01-01T00:00:00.000Z"), firstMessage: "brave" }),
		];
		expect(filterAndSortSessions(sessions, "re:(", "recent")).toEqual([]);
	});

	describe("name filter", () => {
		const sessions = [
			makeSession({
				id: "named1",
				name: "My Project",
				modified: new Date("2026-01-03T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "named2",
				name: "Another Named",
				modified: new Date("2026-01-02T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "other1",
				modified: new Date("2026-01-04T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
			makeSession({
				id: "other2",
				modified: new Date("2026-01-01T00:00:00.000Z"),
				firstMessage: "blueberry",
			}),
		];

		it("returns all sessions when nameFilter is all", () => {
			expect(filterAndSortSessions(sessions, "", "recent", "all").map((session) => session.id)).toEqual([
				"named1",
				"named2",
				"other1",
				"other2",
			]);
		});

		it("returns only named sessions when nameFilter is named", () => {
			expect(filterAndSortSessions(sessions, "", "recent", "named").map((session) => session.id)).toEqual([
				"named1",
				"named2",
			]);
		});

		it("applies name filter before search query", () => {
			expect(filterAndSortSessions(sessions, "blueberry", "recent", "named").map((session) => session.id)).toEqual([
				"named1",
				"named2",
			]);
		});

		it("excludes whitespace-only names from named filter", () => {
			const sessionsWithWhitespace = [
				makeSession({
					id: "whitespace",
					name: "   ",
					modified: new Date("2026-01-01T00:00:00.000Z"),
					firstMessage: "test",
				}),
				makeSession({
					id: "empty",
					name: "",
					modified: new Date("2026-01-02T00:00:00.000Z"),
					firstMessage: "test",
				}),
				makeSession({
					id: "named",
					name: "Real Name",
					modified: new Date("2026-01-03T00:00:00.000Z"),
					firstMessage: "test",
				}),
			];

			expect(
				filterAndSortSessions(sessionsWithWhitespace, "", "recent", "named").map((session) => session.id),
			).toEqual(["named"]);
		});
	});
});
