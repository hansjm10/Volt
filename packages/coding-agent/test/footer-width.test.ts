import { visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	fastModeEnabled?: boolean;
	usage?: AssistantUsage;
	usingSubscription?: boolean;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	contextWarningTokens?: number;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const contextWindow = options.contextWindow ?? 200_000;
	const contextTokens = options.contextTokens === undefined ? 24_600 : options.contextTokens;
	const session = {
		fastModeEnabled: options.fastModeEnabled ?? false,
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			tokens: contextTokens,
			contextWindow,
			percent: options.contextPercent === undefined ? 12.3 : options.contextPercent,
		}),
		modelRegistry: {
			isUsingOAuth: () => options.usingSubscription ?? false,
		},
		settingsManager: {
			getContextWarningTokens: () => options.contextWarningTokens ?? 350_000,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it.each([80, 120, 160])("shows Fast mode alongside thinking at width %s", (width) => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "gpt-5.4",
				provider: "openai",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
			}),
			createFooterData(2),
		);

		const workspaceLine = stripAnsi(footer.render(width)[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it("preserves Fast mode and thinking when a long model name is truncated", () => {
		const width = 40;
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "gpt-5.4-very-long-model-name-that-needs-truncation",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
			}),
			createFooterData(2),
		);

		const workspaceLine = stripAnsi(footer.render(width)[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it.each([11, 12, 13])("keeps the Fast suffix within a narrow width of %s", (width) => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "gpt-5.4",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
			}),
			createFooterData(1),
		);

		const workspaceLine = stripAnsi(footer.render(width)[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it("does not show the Fast marker when Fast mode is disabled", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				reasoning: true,
				thinkingLevel: "high",
			}),
			createFooterData(1),
		);

		expect(stripAnsi(footer.render(120)[0])).not.toContain("fast");
	});

	it.each(["off", "low", "high"])("keeps the Fast marker independent of thinking level %s", (thinkingLevel) => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				reasoning: true,
				thinkingLevel,
				fastModeEnabled: true,
			}),
			createFooterData(1),
		);

		const workspaceLine = stripAnsi(footer.render(120)[0]);
		expect(workspaceLine).toContain(`fast · ${thinkingLevel}`);
	});

	it("reuses session aggregates until invalidated", () => {
		let entryReads = 0;
		let contextReads = 0;
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
		const getEntries = session.sessionManager.getEntries.bind(session.sessionManager);
		session.sessionManager.getEntries = () => {
			entryReads++;
			return getEntries();
		};
		const getContextUsage = session.getContextUsage.bind(session);
		session.getContextUsage = () => {
			contextReads++;
			return getContextUsage();
		};
		const footer = new FooterComponent(session, createFooterData(1));

		footer.render(120);
		footer.render(100);
		expect(entryReads).toBe(1);
		expect(contextReads).toBe(1);

		footer.invalidate();
		footer.render(120);
		expect(entryReads).toBe(2);
		expect(contextReads).toBe(2);
	});

	it("labels subscription billing without showing a misleading zero cost", () => {
		const footer = new FooterComponent(
			createSession({ sessionName: "", usingSubscription: true }),
			createFooterData(1),
		);

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("subscription");
		expect(statsLine).not.toContain("$0.000");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("shows transient isolated-workflow usage without changing the workspace session", () => {
		const session = createSession({
			sessionName: "parent-session",
			modelId: "parent-model",
			reasoning: true,
			thinkingLevel: "low",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.1 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setTransientUsage({
			model: { ...session.state.model!, id: "review-model", contextWindow: 100_000 },
			thinkingLevel: "high",
			fastModeEnabled: true,
			contextUsage: { tokens: 75_000, contextWindow: 100_000, percent: 75 },
			totals: { input: 300, output: 30, cacheRead: 150, cacheWrite: 0, cost: 0.3 },
			latestCacheHitRate: 50,
		});

		const workflowLines = footer.render(120).map(stripAnsi);
		expect(workflowLines[0]).toContain("project · main · parent-session");
		expect(workflowLines[0]).toContain("review-model · fast · high");
		expect(workflowLines[1]).toContain("context 75.0%/100k auto");
		expect(workflowLines[1]).toContain("$0.300");
		expect(workflowLines[1]).toContain("CH50.0%");

		footer.setTransientUsage(undefined);
		const restoredLines = footer.render(120).map(stripAnsi);
		expect(restoredLines[0]).toContain("parent-model · low");
		expect(restoredLines[1]).toContain("context 12.3%/200k auto");
		expect(restoredLines[1]).toContain("$0.100");
	});

	it("warns at the configured absolute context threshold", () => {
		const warningFooter = new FooterComponent(
			createSession({
				sessionName: "",
				contextTokens: 350_000,
				contextWindow: 1_000_000,
				contextPercent: 35,
				contextWarningTokens: 350_000,
			}),
			createFooterData(1),
		);
		const mutedFooter = new FooterComponent(
			createSession({
				sessionName: "",
				contextTokens: 350_000,
				contextWindow: 1_000_000,
				contextPercent: 35,
				contextWarningTokens: 400_000,
			}),
			createFooterData(1),
		);

		expect(warningFooter.render(120)[1]).toContain(theme.fg("warning", "35.0%/1.0M auto"));
		expect(mutedFooter.render(120)[1]).toContain(theme.fg("muted", "35.0%/1.0M auto"));
	});
});
