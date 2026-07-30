import type { GitContextProvider } from "./git-context-provider.ts";
import type { RpcGitContext } from "./rpc/types.ts";

function branchFromSnapshot(snapshot: RpcGitContext | null): string | null {
	if (!snapshot) return null;
	return snapshot.head.kind === "detached" ? "detached" : snapshot.head.name;
}

/**
 * Provides Git branch and extension statuses for the interactive footer.
 * Git collection is owned by the session's shared GitContextProvider.
 */
export class FooterDataProvider {
	private gitContextProvider: GitContextProvider;
	private unsubscribeGitContext: (() => void) | null = null;
	private extensionStatuses = new Map<string, string>();
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private cachedBranch: string | null;
	private disposed = false;

	constructor(gitContextProvider: GitContextProvider) {
		this.gitContextProvider = gitContextProvider;
		this.cachedBranch = branchFromSnapshot(gitContextProvider.getSnapshot());
		this.subscribeToGitContext();
	}

	/** Current Git branch, null if not in a repo, "detached" if detached HEAD. */
	getGitBranch(): string | null {
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus(). */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to Git branch changes. Returns an unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status. */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses. */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display). */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count. */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** Rebind after the interactive runtime replaces its cwd-bound services. */
	setGitContextProvider(gitContextProvider: GitContextProvider): void {
		if (this.gitContextProvider === gitContextProvider) return;
		this.unsubscribeGitContext?.();
		this.gitContextProvider = gitContextProvider;
		const previousBranch = this.cachedBranch;
		this.cachedBranch = branchFromSnapshot(gitContextProvider.getSnapshot());
		this.subscribeToGitContext();
		if (previousBranch !== this.cachedBranch) this.notifyBranchChange();
	}

	/** Internal: cleanup. The session runtime owns the shared provider. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeGitContext?.();
		this.unsubscribeGitContext = null;
		this.branchChangeCallbacks.clear();
	}

	private subscribeToGitContext(): void {
		if (this.disposed) return;
		this.unsubscribeGitContext = this.gitContextProvider.subscribe((snapshot) => {
			const nextBranch = branchFromSnapshot(snapshot);
			if (nextBranch === this.cachedBranch) return;
			this.cachedBranch = nextBranch;
			this.notifyBranchChange();
		});
	}

	private notifyBranchChange(): void {
		for (const callback of this.branchChangeCallbacks) callback();
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose. */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
