import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import {
	registerDurableReviewAnchor,
	registerReviewHandoffAliases,
	resolveCanonicalReviewSource,
} from "../../../src/core/review-anchors.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-empty-handoff-"));
	const directory = join(root, "sessions");
	const managers: SessionManager[] = [];
	const harnesses: Harness[] = [];
	let runtime: AgentSessionRuntime | undefined;
	cleanups.push(async () => {
		await runtime?.dispose();
		for (const manager of managers) await manager.closePersistence();
		for (const harness of harnesses) await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
		const h = await createHarness({ sessionManager, settings: { lsp: { enabled: false } } });
		harnesses.push(h);
		return {
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			diagnostics: [],
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: h.authStorage,
				modelRegistry: h.session.modelRegistry,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				gitContextProvider: h.session.gitContextProvider,
				diagnostics: [],
			},
		};
	};
	const source = await SessionManager.create(root, directory);
	managers.push(source);
	runtime = await createAgentSessionRuntime(factory, { sessionManager: source, cwd: root, agentDir: root });
	return { root, directory, source, runtime, managers };
}

describe("#342 empty review handoffs", () => {
	it("creates a new session in another store without transferring review runs", async () => {
		const { root, source, runtime } = await fixture();
		const original = source.getSessionRef()!;
		const sessionDir = join(root, "other-store");
		await expect(runtime.newSession({ sessionDir })).resolves.toEqual({ cancelled: false, seeded: false });
		expect(runtime.session.sessionManager.getSessionDir()).toBe(sessionDir);
		expect(runtime.session.sessionRef!.storeId).not.toBe(original.storeId);
		expect(runtime.session.sessionId).not.toBe(original.sessionId);
	});

	it("allows empty cross-store handoffs but rejects actual review linkage", async () => {
		const { root, source, managers } = await fixture();
		const target = await SessionManager.create(root, join(root, "other-store"));
		managers.push(target);
		await registerDurableReviewAnchor(source, "run");
		await expect(registerReviewHandoffAliases(source, target, [])).resolves.toBeUndefined();
		await expect(registerReviewHandoffAliases(source, target, ["run"])).rejects.toThrow(
			"Review handoff crosses stores",
		);
		expect(await resolveCanonicalReviewSource(target, "run")).toBeUndefined();
	});

	it("retains same-store alias registration", async () => {
		const { root, directory, source, managers } = await fixture();
		const target = await SessionManager.create(root, directory);
		managers.push(target);
		await registerDurableReviewAnchor(source, "run");
		await registerReviewHandoffAliases(source, target, ["run"]);
		expect(await resolveCanonicalReviewSource(target, "run")).toEqual(source.getSessionRef());
	});
});
