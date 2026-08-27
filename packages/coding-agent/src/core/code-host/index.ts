import { githubCliCodeHostProvider } from "./github-cli-provider.ts";
import type { CodeHostProvider } from "./types.ts";

export { githubCliCodeHostProvider } from "./github-cli-provider.ts";
export type {
	CodeHostProvider,
	CodeHostPullRequestSummary,
	PullRequestFetchPlan,
	PullRequestFetchRef,
	ReviewCodeHostActor,
	ReviewCodeHostContext,
	ReviewCodeHostContextCaptureOptions,
	ReviewCodeHostContextCaptureResult,
	ReviewCodeHostContextLimitation,
	ReviewCodeHostContextLimitationCode,
	ReviewCodeHostContextManifest,
	ReviewCodeHostDiscussionEntry,
	ReviewCodeHostInlineComment,
	ReviewCodeHostLinkedIssue,
	ReviewCodeHostPublishRequest,
	ReviewCodeHostPublishResult,
	ReviewPullRequestIdentity,
} from "./types.ts";

export function getCodeHostProvider(providerId: string): CodeHostProvider {
	if (providerId === githubCliCodeHostProvider.id) return githubCliCodeHostProvider;
	throw new Error(`Unsupported code-host provider: ${JSON.stringify(providerId)}.`);
}
