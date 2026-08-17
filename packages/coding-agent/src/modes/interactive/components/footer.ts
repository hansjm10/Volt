import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../../../core/theme/runtime.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

type FooterSnapshot = {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	latestCacheHitRate: number | undefined;
	contextUsage: ReturnType<AgentSession["getContextUsage"]>;
};

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~/${relativeToHome.replace(/\\/g, "/")}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private snapshot?: FooterSnapshot;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.snapshot = undefined;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Clear session-derived aggregates. Git branch caching is handled by the provider. */
	invalidate(): void {
		this.snapshot = undefined;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private getSnapshot(): FooterSnapshot {
		if (this.snapshot) return this.snapshot;

		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let latestCacheHitRate: number | undefined;
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			}
		}
		this.snapshot = {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			latestCacheHitRate,
			contextUsage: this.session.getContextUsage(),
		};
		return this.snapshot;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const state = this.session.state;
		const { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost, latestCacheHitRate, contextUsage } =
			this.getSnapshot();

		const cwd = this.session.sessionManager.getCwd();
		const workspace =
			width < 100
				? basename(resolve(cwd)) || cwd
				: formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
		const workspaceParts = [workspace];
		const branch = this.footerData.getGitBranch();
		if (branch) workspaceParts.push(branch);
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) workspaceParts.push(sessionName);

		const workspaceSide =
			theme.fg("text", workspaceParts[0]!) +
			(workspaceParts.length > 1 ? theme.fg("dim", ` · ${workspaceParts.slice(1).join(" · ")}`) : "");
		const modelName = state.model?.id || "no-model";
		const provider =
			width >= 100 && this.footerData.getAvailableProviderCount() > 1 && state.model
				? theme.fg("dim", `(${state.model.provider}) `)
				: "";
		const thinking = state.model?.reasoning ? theme.fg("dim", ` · ${state.thinkingLevel || "off"}`) : "";
		const model = theme.fg("text", modelName);
		const fastLabel = theme.bold(theme.fg("warning", "fast"));
		const fast = this.session.fastModeEnabled ? `${theme.fg("dim", " · ")}${fastLabel}` : "";
		let modelSide = `${provider}${model}${fast}${thinking}`;
		if (visibleWidth(modelSide) >= width) {
			const modelWithoutProvider = `${model}${fast}${thinking}`;
			if (visibleWidth(modelWithoutProvider) < width) {
				modelSide = modelWithoutProvider;
			} else if (this.session.fastModeEnabled) {
				const fastAndThinking = `${fastLabel}${thinking}`;
				if (visibleWidth(fastAndThinking) > width) {
					modelSide = truncateToWidth(fastLabel, width, "");
				} else {
					const suffix = `${fast}${thinking}`;
					if (visibleWidth(suffix) >= width) {
						modelSide = fastAndThinking;
					} else {
						const modelWidth = width - visibleWidth(suffix);
						modelSide = `${truncateToWidth(model, modelWidth, "")}${suffix}`;
					}
				}
			} else {
				modelSide = truncateToWidth(modelWithoutProvider, width, "");
			}
		}

		const modelWidth = visibleWidth(modelSide);
		const availableWorkspaceWidth = Math.max(0, width - modelWidth - (modelWidth > 0 ? 2 : 0));
		const fittedWorkspace = truncateToWidth(workspaceSide, availableWorkspaceWidth, theme.fg("dim", "…"));
		const workspaceWidth = visibleWidth(fittedWorkspace);
		const workspacePadding = " ".repeat(Math.max(0, width - workspaceWidth - modelWidth));
		const workspaceLine = `${fittedWorkspace}${workspacePadding}${modelSide}`;

		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const autoIndicator = this.autoCompactEnabled ? " auto" : "";
		const contextDisplay = `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`.replace("?%", "?");
		const contextWarningTokens = this.session.settingsManager.getContextWarningTokens();
		const contextTokens = contextUsage?.tokens;
		const reachedTokenWarning =
			contextWarningTokens > 0 &&
			contextTokens !== undefined &&
			contextTokens !== null &&
			contextTokens >= contextWarningTokens;
		const contextValue =
			contextPercentValue > 90
				? theme.fg("error", contextDisplay)
				: contextPercentValue > 70 || reachedTokenWarning
					? theme.fg("warning", contextDisplay)
					: theme.fg("muted", contextDisplay);

		const detailParts = [`${theme.fg("dim", "context")} ${contextValue}`];
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (usingSubscription) detailParts.push(theme.fg("dim", "subscription"));
		if (totalCost) detailParts.push(theme.fg("dim", `$${totalCost.toFixed(3)}`));
		if (totalInput) detailParts.push(theme.fg("dim", `↑${formatTokens(totalInput)}`));
		if (totalOutput) detailParts.push(theme.fg("dim", `↓${formatTokens(totalOutput)}`));
		if (totalCacheRead) detailParts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
		if (totalCacheWrite) detailParts.push(theme.fg("dim", `W${formatTokens(totalCacheWrite)}`));
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
			detailParts.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
		}
		if (areExperimentalFeaturesEnabled()) {
			detailParts.push(theme.bold(theme.fg("warning", "xp")));
		}
		const detailLine = truncateToWidth(detailParts.join(theme.fg("dim", " · ")), width, theme.fg("dim", "…"));
		const lines = [workspaceLine, detailLine];

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "…")));
		}

		return lines;
	}
}
