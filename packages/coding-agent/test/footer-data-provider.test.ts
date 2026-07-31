import { describe, expect, it, vi } from "vitest";
import { FooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { GitContextListener, GitContextProvider } from "../src/core/git-context-provider.ts";
import type { RpcGitContext } from "../src/core/rpc/types.ts";

const OID = "0123456789abcdef0123456789abcdef01234567";

function snapshot(head: RpcGitContext["head"], revision = 1): RpcGitContext {
	return {
		repository: "repository",
		head,
		upstream: null,
		base: null,
		status: {
			staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
			unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
			untracked: 0,
			conflicted: 0,
			total: 0,
			clean: true,
		},
		operation: null,
		revision,
		observedAt: "2026-07-29T00:00:00.000Z",
		stale: false,
	};
}

class FakeGitContextProvider {
	private listeners = new Set<GitContextListener>();
	private current: RpcGitContext | null;

	constructor(current: RpcGitContext | null) {
		this.current = current;
	}

	getSnapshot(): RpcGitContext | null {
		return this.current;
	}

	subscribe(listener: GitContextListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(next: RpcGitContext | null): void {
		this.current = next;
		for (const listener of this.listeners) listener(next);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	asProvider(): GitContextProvider {
		return this as unknown as GitContextProvider;
	}
}

describe("FooterDataProvider", () => {
	it("projects branch, detached, unborn, and non-Git snapshots", () => {
		const gitContext = new FakeGitContextProvider(snapshot({ kind: "branch", name: "main", oid: OID }));
		const provider = new FooterDataProvider(gitContext.asProvider());
		expect(provider.getGitBranch()).toBe("main");

		gitContext.emit(snapshot({ kind: "detached", oid: OID }, 2));
		expect(provider.getGitBranch()).toBe("detached");
		gitContext.emit(snapshot({ kind: "unborn", name: "new-branch" }, 3));
		expect(provider.getGitBranch()).toBe("new-branch");
		gitContext.emit(null);
		expect(provider.getGitBranch()).toBeNull();
		provider.dispose();
	});

	it("notifies only when the displayed branch changes", () => {
		const gitContext = new FakeGitContextProvider(snapshot({ kind: "branch", name: "main", oid: OID }));
		const provider = new FooterDataProvider(gitContext.asProvider());
		const listener = vi.fn();
		provider.onBranchChange(listener);

		gitContext.emit({ ...snapshot({ kind: "branch", name: "main", oid: OID }, 2), stale: true });
		expect(listener).not.toHaveBeenCalled();
		gitContext.emit(snapshot({ kind: "branch", name: "feature", oid: OID }, 3));
		expect(listener).toHaveBeenCalledTimes(1);
		provider.dispose();
	});

	it("rebinds to a replacement provider while preserving extension footer state", () => {
		const first = new FakeGitContextProvider(snapshot({ kind: "branch", name: "main", oid: OID }));
		const second = new FakeGitContextProvider(snapshot({ kind: "branch", name: "worktree", oid: OID }));
		const provider = new FooterDataProvider(first.asProvider());
		const listener = vi.fn();
		provider.onBranchChange(listener);
		provider.setExtensionStatus("extension", "ready");
		provider.setAvailableProviderCount(3);

		provider.setGitContextProvider(second.asProvider());
		expect(first.listenerCount).toBe(0);
		expect(second.listenerCount).toBe(1);
		expect(provider.getGitBranch()).toBe("worktree");
		expect(provider.getExtensionStatuses().get("extension")).toBe("ready");
		expect(provider.getAvailableProviderCount()).toBe(3);
		expect(listener).toHaveBeenCalledTimes(1);
		provider.dispose();
		expect(second.listenerCount).toBe(0);
	});

	it("updates and clears extension statuses independently of Git context", () => {
		const gitContext = new FakeGitContextProvider(null);
		const provider = new FooterDataProvider(gitContext.asProvider());
		provider.setExtensionStatus("one", "first");
		provider.setExtensionStatus("two", "second");
		provider.setExtensionStatus("one", undefined);
		expect([...provider.getExtensionStatuses()]).toEqual([["two", "second"]]);
		provider.clearExtensionStatuses();
		expect(provider.getExtensionStatuses().size).toBe(0);
		provider.dispose();
	});
});
