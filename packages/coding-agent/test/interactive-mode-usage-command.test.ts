import type { SubscriptionUsageError } from "@hansjm10/volt-ai";
import { Container } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import type { SubscriptionUsageReport } from "../src/core/subscription-usage.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type UsageCommandContext = {
	subscriptionUsageService: {
		fetch(authStorage: unknown, activeProviderId: string): Promise<SubscriptionUsageReport>;
	};
	session: {
		model: { provider: string };
		modelRegistry: {
			authStorage: unknown;
			getProviderDisplayName(providerId: string): string;
		};
	};
	chatContainer: Container;
	ui: { requestRender(): void };
	showStatus(message: string): void;
	formatSubscriptionUsageError(error: SubscriptionUsageError): string;
	formatSubscriptionPlan(plan: string): string;
	formatRemainingPercent(usedPercent: number): string;
};

type UsageCommandPrototype = {
	handleUsageCommand(this: UsageCommandContext): Promise<void>;
	formatSubscriptionUsageError(this: UsageCommandContext, error: SubscriptionUsageError): string;
	formatSubscriptionPlan(this: UsageCommandContext, plan: string): string;
	formatRemainingPercent(this: UsageCommandContext, usedPercent: number): string;
};

const prototype = InteractiveMode.prototype as unknown as UsageCommandPrototype;

function createContext(report: SubscriptionUsageReport) {
	const chatContainer = new Container();
	const showStatus = vi.fn<(message: string) => void>();
	const requestRender = vi.fn();
	const fetch = vi.fn(async () => report);
	const context: UsageCommandContext = {
		subscriptionUsageService: { fetch },
		session: {
			model: { provider: "provider-b" },
			modelRegistry: {
				authStorage: {},
				getProviderDisplayName: (providerId) =>
					providerId === "provider-a" ? "Provider A" : providerId === "provider-b" ? "Provider B" : providerId,
			},
		},
		chatContainer,
		ui: { requestRender },
		showStatus,
		formatSubscriptionUsageError: prototype.formatSubscriptionUsageError,
		formatSubscriptionPlan: prototype.formatSubscriptionPlan,
		formatRemainingPercent: prototype.formatRemainingPercent,
	};
	return { context, fetch, requestRender, showStatus };
}

describe("InteractiveMode /usage", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("is registered as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "usage",
			description: "Show remaining subscription quota and reset times",
		});
	});

	it("renders normalized successes and errors without provider-specific data", async () => {
		const resetsAt = Date.parse("2026-08-21T18:00:00Z");
		const { context, fetch, requestRender, showStatus } = createContext({
			status: "providers",
			providers: [
				{
					providerId: "provider-b",
					result: {
						status: "success",
						snapshot: {
							providerId: "provider-b",
							fetchedAt: 1_800_000_000_000,
							plan: "team_plan",
							limits: [
								{
									id: "weekly",
									label: "Weekly",
									usedPercent: 25.5,
									resetsAt,
									limitReached: true,
								},
							],
						},
					},
				},
				{
					providerId: "provider-a",
					result: {
						status: "error",
						error: { code: "rate_limited", message: "raw provider message is not rendered" },
					},
				},
			],
		});

		await prototype.handleUsageCommand.call(context);

		const rendered = stripAnsi(context.chatContainer.render(120).lines.join("\n"));
		expect(fetch).toHaveBeenCalledWith({}, "provider-b");
		expect(rendered).toContain("Subscription Usage");
		expect(rendered).toContain("Provider B · Team Plan");
		expect(rendered).toContain("Weekly: 74.5% remaining");
		expect(rendered).toContain(`resets ${new Date(resetsAt).toLocaleString()}`);
		expect(rendered).toContain("limit reached");
		expect(rendered).toContain("Provider A");
		expect(rendered).toContain("Usage status is rate limited. Try again later.");
		expect(rendered).not.toContain("raw provider message");
		expect(showStatus).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it.each([
		{
			report: { status: "no_subscription" } as const,
			message: "No subscription login is configured. Use /login to connect a supported provider.",
		},
		{
			report: { status: "unsupported" } as const,
			message: "Stored subscription credentials do not expose quota usage in Volt.",
		},
	])("renders the $report.status state clearly", async ({ report, message }) => {
		const { context, showStatus } = createContext(report);

		await prototype.handleUsageCommand.call(context);

		expect(showStatus).toHaveBeenCalledWith(message);
		expect(context.chatContainer.children).toHaveLength(0);
	});
});
