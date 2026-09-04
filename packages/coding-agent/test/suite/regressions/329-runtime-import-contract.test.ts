import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import {
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	SessionManager,
	type SessionTreeNode,
} from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SessionStoreApplyTransactionInput,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const HEADER_TIMESTAMP = "2025-01-01T00:00:00.000Z";
const LEAF_TIMESTAMP = "2025-01-01T00:59:00.000Z";

interface RuntimeFixture {
	runtime: AgentSessionRuntime;
	cwd: string;
	sessionDir: string;
	root: string;
	modelProvider: string;
	modelId: string;
}

const harnesses: Harness[] = [];
const runtimes: AgentSessionRuntime[] = [];
const openedManagers: SessionManager[] = [];
const storeLeases: SQLiteSessionStoreLease[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of openedManagers.splice(0).reverse()) await manager.closePersistence();
	for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose();
	for (const lease of storeLeases.splice(0).reverse()) await lease.release();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
});

async function createRuntimeFixture(options: { persisted?: boolean } = {}): Promise<RuntimeFixture> {
	const fauxHarness = await createHarness({ settings: { lsp: { enabled: false } } });
	harnesses.push(fauxHarness);
	const root = fauxHarness.tempDir;
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	const initialManager =
		options.persisted === false
			? SessionManager.inMemory(cwd)
			: await SessionManager.create(cwd, sessionDir, { id: "runtime-source" });
	const model = fauxHarness.getModel();
	initialManager.appendModelChange(model.provider, model.id);
	initialManager.appendThinkingLevelChange("off");
	await initialManager.flush();

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			authStorage: fauxHarness.authStorage,
			settingsManager: fauxHarness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			noTools: "all",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: root,
		sessionManager: initialManager,
	});
	runtimes.push(runtime);
	await runtime.session.bindExtensions({});
	return { runtime, cwd, sessionDir, root, modelProvider: model.provider, modelId: model.id };
}

function snapshotPolicyEntries(modelProvider: string, modelId: string): Record<string, unknown>[] {
	return [
		{
			type: "model_change",
			id: "policy-model",
			parentId: null,
			ordinal: 1,
			timestamp: "2025-01-01T00:00:10.000Z",
			provider: modelProvider,
			modelId,
		},
		{
			type: "thinking_level_change",
			id: "policy-thinking",
			parentId: "policy-model",
			ordinal: 2,
			timestamp: "2025-01-01T00:00:20.000Z",
			thinkingLevel: "off",
		},
	];
}

function writeSnapshot(
	path: string,
	cwd: string,
	id: string,
	entries: readonly Record<string, unknown>[],
	leafTargetId: string | null,
): void {
	const lastEntry = entries.at(-1);
	if (lastEntry !== undefined && typeof lastEntry.id !== "string") {
		throw new Error("Snapshot fixture entries require string ids");
	}
	writeFileSync(
		path,
		`${[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
				id,
				timestamp: HEADER_TIMESTAMP,
				cwd,
			},
			...entries,
			{
				type: "leaf",
				id: `${id}-leaf`,
				parentId: lastEntry?.id ?? null,
				ordinal: entries.length + 1,
				timestamp: LEAF_TIMESTAMP,
				targetId: leafTargetId,
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

function flattenTree(roots: readonly SessionTreeNode[]): SessionTreeNode[] {
	const pending = [...roots];
	const flattened: SessionTreeNode[] = [];
	while (pending.length > 0) {
		const node = pending.shift();
		if (!node) continue;
		flattened.push(node);
		pending.push(...node.children);
	}
	return flattened;
}

function entryText(entry: SessionEntry): string | undefined {
	if (entry.type === "message") return getMessageText(entry.message);
	if (entry.type === "custom_message") return getMessageText({ content: entry.content });
	return undefined;
}

function transactionCustomTypes(input: SessionStoreApplyTransactionInput): string[] {
	return input.payload.entries.flatMap(({ entry }) => {
		if (entry === null || typeof entry !== "object" || !("customType" in entry)) return [];
		return typeof entry.customType === "string" ? [entry.customType] : [];
	});
}

describe("PR #329 AgentSessionRuntime JSONL import contract", () => {
	it("preserves canonical timestamps and derived behavior for in-memory runtime imports", async () => {
		const { runtime, cwd, root, modelProvider, modelId } = await createRuntimeFixture({ persisted: false });
		const snapshotPath = join(root, "in-memory-canonical-import.jsonl");
		const rootTimestamp = "2025-01-01T00:01:00.000Z";
		const labelTimestamp = "2025-01-01T00:02:00.000Z";
		const displayedTimestamp = "2025-01-01T00:03:00.000Z";
		writeSnapshot(
			snapshotPath,
			cwd,
			"in-memory-canonical-import",
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				{
					type: "message",
					id: "in-memory-root",
					parentId: "policy-thinking",
					ordinal: 3,
					timestamp: rootTimestamp,
					message: { role: "user", content: "in-memory root", timestamp: Date.parse(rootTimestamp) },
				},
				{
					type: "label",
					id: "in-memory-label",
					parentId: "in-memory-root",
					ordinal: 4,
					timestamp: labelTimestamp,
					targetId: "in-memory-root",
					label: "in-memory checkpoint",
				},
				{
					type: "custom_message",
					id: "in-memory-displayed",
					parentId: "in-memory-label",
					ordinal: 5,
					timestamp: displayedTimestamp,
					customType: "rfc.in-memory",
					content: "in-memory displayed",
					display: true,
				},
			],
			"in-memory-displayed",
		);

		await runtime.importFromJsonl(snapshotPath);
		const manager = runtime.session.sessionManager;
		const importedEntries = manager.getEntries().filter((entry) => entry.id.startsWith("in-memory-"));
		const rootEntry = importedEntries.find((entry) => entry.id === "in-memory-root");
		const rootNode = flattenTree(manager.getTree()).find((node) => node.entry.id === "in-memory-root");
		const context = manager.buildSessionContext();

		expect.soft(runtime.session.sessionRef).toBeUndefined();
		expect.soft(importedEntries.map((entry) => [entry.id, entry.timestamp])).toEqual([
			["in-memory-root", rootTimestamp],
			["in-memory-label", labelTimestamp],
			["in-memory-displayed", displayedTimestamp],
		]);
		expect.soft(manager.getLeafId()).toBe("in-memory-displayed");
		expect.soft(rootEntry && manager.getLabel(rootEntry.id)).toBe("in-memory checkpoint");
		expect.soft(rootNode?.label).toBe("in-memory checkpoint");
		expect.soft(rootNode?.labelTimestamp).toBe(labelTimestamp);
		expect.soft(manager.getSessionEntrySummary()).toEqual({
			messageCount: 2,
			firstMessage: "in-memory root",
			lastActivityTime: Date.parse(displayedTimestamp),
		});
		expect
			.soft(
				context.messages.map((message) => ({
					role: message.role,
					text: getMessageText(message),
					timestamp: message.timestamp,
				})),
			)
			.toEqual([
				{ role: "user", text: "in-memory root", timestamp: Date.parse(rootTimestamp) },
				{ role: "custom", text: "in-memory displayed", timestamp: Date.parse(displayedTimestamp) },
			]);
	});

	it("preserves canonical entry and label timestamps after reopen", async () => {
		const { runtime, cwd, root, modelProvider, modelId } = await createRuntimeFixture();
		const snapshotPath = join(root, "timestamp-label-import.jsonl");
		const rootTimestamp = "2025-01-01T00:01:00.000Z";
		const labelTimestamp = "2025-01-01T00:02:00.000Z";
		writeSnapshot(
			snapshotPath,
			cwd,
			"timestamp-label-import",
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				{
					type: "message",
					id: "source-root",
					parentId: "policy-thinking",
					ordinal: 3,
					timestamp: rootTimestamp,
					message: { role: "user", content: "labeled root", timestamp: Date.parse(rootTimestamp) },
				},
				{
					type: "label",
					id: "source-label",
					parentId: "source-root",
					ordinal: 4,
					timestamp: labelTimestamp,
					targetId: "source-root",
					label: "checkpoint",
				},
			],
			"source-label",
		);

		await runtime.importFromJsonl(snapshotPath);
		const importedRef = runtime.session.sessionRef;
		if (!importedRef) throw new Error("Expected a persisted imported session");
		const reopened = await SessionManager.open(importedRef);
		openedManagers.push(reopened);
		const entries = reopened.getEntries();
		const rootEntry = entries.find((entry) => entry.type === "message" && entryText(entry) === "labeled root");
		const labelEntry = entries.find((entry) => entry.type === "label" && entry.label === "checkpoint");
		const rootNode = flattenTree(reopened.getTree()).find(
			(node) => node.entry.type === "message" && entryText(node.entry) === "labeled root",
		);

		expect.soft(rootEntry?.timestamp).toBe(rootTimestamp);
		expect.soft(labelEntry?.timestamp).toBe(labelTimestamp);
		expect.soft(rootEntry && reopened.getLabel(rootEntry.id)).toBe("checkpoint");
		expect.soft(rootNode?.label).toBe("checkpoint");
		expect.soft(rootNode?.labelTimestamp).toBe(labelTimestamp);
	});

	it("preserves branch-summary and compaction timestamps in canonical and model context after import", async () => {
		const { runtime, cwd, root, modelProvider, modelId } = await createRuntimeFixture();
		const snapshotPath = join(root, "summary-context-import.jsonl");
		const rootTimestamp = "2025-01-01T00:01:00.000Z";
		const branchSummaryTimestamp = "2025-01-01T00:02:00.000Z";
		const retainedTimestamp = "2025-01-01T00:03:00.000Z";
		const compactionTimestamp = "2025-01-01T00:04:00.000Z";
		const branchSummary = "imported branch summary marker";
		const compactionSummary = "imported compaction summary marker";
		writeSnapshot(
			snapshotPath,
			cwd,
			"summary-context-import",
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				{
					type: "message",
					id: "context-root",
					parentId: "policy-thinking",
					ordinal: 3,
					timestamp: rootTimestamp,
					message: { role: "user", content: "context root", timestamp: Date.parse(rootTimestamp) },
				},
				{
					type: "branch_summary",
					id: "source-branch-summary",
					parentId: "context-root",
					ordinal: 4,
					timestamp: branchSummaryTimestamp,
					fromId: "context-root",
					summary: branchSummary,
				},
				{
					type: "message",
					id: "retained-message",
					parentId: "source-branch-summary",
					ordinal: 5,
					timestamp: retainedTimestamp,
					message: { role: "user", content: "retained context", timestamp: Date.parse(retainedTimestamp) },
				},
				{
					type: "compaction",
					id: "source-compaction",
					parentId: "retained-message",
					ordinal: 6,
					timestamp: compactionTimestamp,
					summary: compactionSummary,
					firstKeptEntryId: "source-branch-summary",
					tokensBefore: 321,
				},
			],
			"source-compaction",
		);

		await runtime.importFromJsonl(snapshotPath);
		const importedRef = runtime.session.sessionRef;
		if (!importedRef) throw new Error("Expected a persisted imported session");
		const reopened = await SessionManager.open(importedRef);
		openedManagers.push(reopened);
		const importedBranchSummary = reopened
			.getEntries()
			.find((entry) => entry.type === "branch_summary" && entry.summary === branchSummary);
		const importedCompaction = reopened
			.getEntries()
			.find((entry) => entry.type === "compaction" && entry.summary === compactionSummary);
		const modelSummaryTimestamps = runtime.session.messages.flatMap((message) => {
			if (message.role === "compactionSummary" && message.summary === compactionSummary) {
				return [{ summary: compactionSummary, timestamp: message.timestamp }];
			}
			if (message.role === "branchSummary" && message.summary === branchSummary) {
				return [{ summary: branchSummary, timestamp: message.timestamp }];
			}
			return [];
		});

		expect.soft(importedBranchSummary?.timestamp).toBe(branchSummaryTimestamp);
		expect.soft(importedCompaction?.timestamp).toBe(compactionTimestamp);
		expect.soft(modelSummaryTimestamps).toEqual([
			{ summary: compactionSummary, timestamp: Date.parse(compactionTimestamp) },
			{ summary: branchSummary, timestamp: Date.parse(branchSummaryTimestamp) },
		]);
	});

	it("reopens the cleared name, selected branch, leaf, and displayed-message activity time", async () => {
		const { runtime, cwd, sessionDir, root, modelProvider, modelId } = await createRuntimeFixture();
		const snapshotPath = join(root, "derived-import.jsonl");
		const rootTimestamp = "2025-01-01T00:01:00.000Z";
		const abandonedTimestamp = "2025-01-01T00:02:00.000Z";
		const activeTimestamp = "2025-01-01T00:03:00.000Z";
		const nameTimestamp = "2025-01-01T00:04:00.000Z";
		const clearTimestamp = "2025-01-01T00:05:00.000Z";
		const displayedTimestamp = "2025-01-01T00:06:00.000Z";
		writeSnapshot(
			snapshotPath,
			cwd,
			"derived-import",
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				{
					type: "message",
					id: "branch-root",
					parentId: "policy-thinking",
					ordinal: 3,
					timestamp: rootTimestamp,
					message: { role: "user", content: "root", timestamp: Date.parse(rootTimestamp) },
				},
				{
					type: "message",
					id: "abandoned-child",
					parentId: "branch-root",
					ordinal: 4,
					timestamp: abandonedTimestamp,
					message: { role: "user", content: "abandoned", timestamp: Date.parse(abandonedTimestamp) },
				},
				{
					type: "message",
					id: "active-child",
					parentId: "branch-root",
					ordinal: 5,
					timestamp: activeTimestamp,
					message: { role: "user", content: "active", timestamp: Date.parse(activeTimestamp) },
				},
				{
					type: "session_info",
					id: "name-set",
					parentId: "active-child",
					ordinal: 6,
					timestamp: nameTimestamp,
					name: "  Temporary name  ",
				},
				{
					type: "session_info",
					id: "name-clear",
					parentId: "name-set",
					ordinal: 7,
					timestamp: clearTimestamp,
					name: "",
				},
				{
					type: "custom_message",
					id: "displayed-child",
					parentId: "name-clear",
					ordinal: 8,
					timestamp: displayedTimestamp,
					customType: "rfc.displayed",
					content: "displayed checkpoint",
					display: true,
				},
			],
			"displayed-child",
		);

		await runtime.importFromJsonl(snapshotPath);
		const importedRef = runtime.session.sessionRef;
		if (!importedRef) throw new Error("Expected a persisted imported session");
		const reopened = await SessionManager.open(importedRef);
		openedManagers.push(reopened);
		const tree = flattenTree(reopened.getTree());
		const rootNode = tree.find((node) => node.entry.type === "message" && entryText(node.entry) === "root");
		const displayedEntry = reopened
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "rfc.displayed");
		const context = reopened.buildSessionContext();
		const stored = (
			await SessionManager.list(cwd, sessionDir, undefined, {
				includeMessageFreeDurable: true,
			})
		).find((session) => session.id === "derived-import");

		expect.soft(reopened.getSessionName()).toBeUndefined();
		expect.soft(stored?.name).toBeUndefined();
		expect.soft(rootNode?.children.map((node) => entryText(node.entry)).sort()).toEqual(["abandoned", "active"]);
		expect.soft(reopened.getLeafEntry()).toMatchObject({
			type: "custom_message",
			customType: "rfc.displayed",
			content: "displayed checkpoint",
		});
		expect
			.soft(context.messages.map((message) => getMessageText(message)))
			.toEqual(["root", "active", "displayed checkpoint"]);
		expect.soft(displayedEntry?.timestamp).toBe(displayedTimestamp);
		expect
			.soft(
				context.messages.find((message) => message.role === "custom" && message.customType === "rfc.displayed")
					?.timestamp,
			)
			.toBe(Date.parse(displayedTimestamp));
		expect.soft(reopened.getSessionEntrySummary()).toEqual({
			messageCount: 4,
			firstMessage: "root",
			lastActivityTime: Date.parse(displayedTimestamp),
		});
		expect.soft(stored?.modified.toISOString()).toBe(displayedTimestamp);
	});

	it("commits all import marker entries together in exactly one batch", async () => {
		const { runtime, cwd, sessionDir, root, modelProvider, modelId } = await createRuntimeFixture();
		const snapshotPath = join(root, "atomic-import.jsonl");
		const customTypes = ["rfc.atomic.one", "rfc.atomic.two", "rfc.atomic.three"];
		writeSnapshot(
			snapshotPath,
			cwd,
			"atomic-import",
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				...customTypes.map((customType, index) => ({
					type: "custom",
					id: `atomic-${index + 1}`,
					parentId: index === 0 ? "policy-thinking" : `atomic-${index}`,
					ordinal: index + 3,
					timestamp: `2025-01-01T00:0${index + 1}:00.000Z`,
					customType,
					data: { index },
				})),
			],
			"atomic-3",
		);
		const lease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(lease);
		const applyTransaction = vi.spyOn(lease.client, "applyTransaction");

		await runtime.importFromJsonl(snapshotPath);

		const markerSet = new Set(customTypes);
		const importedMarkerBatches = applyTransaction.mock.calls
			.map(([input]) => transactionCustomTypes(input).filter((customType) => markerSet.has(customType)))
			.filter((persistedTypes) => persistedTypes.length > 0);
		expect(importedMarkerBatches).toHaveLength(1);
		expect([...(importedMarkerBatches[0] ?? [])].sort()).toEqual([...customTypes].sort());
	});

	it("retains an empty adopted row after an injected import failure with proven rollback", async () => {
		const { runtime, cwd, sessionDir, root, modelProvider, modelId } = await createRuntimeFixture();
		const snapshotPath = join(root, "failed-atomic-import.jsonl");
		const importedId = "failed-atomic-import";
		const failureTrigger = "rfc.failure.trigger";
		writeSnapshot(
			snapshotPath,
			cwd,
			importedId,
			[
				...snapshotPolicyEntries(modelProvider, modelId),
				{
					type: "custom_message",
					id: "failure-prefix",
					parentId: "policy-thinking",
					ordinal: 3,
					timestamp: "2025-01-01T00:01:00.000Z",
					customType: "rfc.failure.prefix",
					content: "must not survive alone",
					display: true,
				},
				{
					type: "custom",
					id: "failure-trigger",
					parentId: "failure-prefix",
					ordinal: 4,
					timestamp: "2025-01-01T00:02:00.000Z",
					customType: failureTrigger,
					data: { fail: true },
				},
				{
					type: "custom",
					id: "failure-suffix",
					parentId: "failure-trigger",
					ordinal: 5,
					timestamp: "2025-01-01T00:03:00.000Z",
					customType: "rfc.failure.suffix",
				},
			],
			"failure-suffix",
		);
		const lease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(lease);
		const applyTransaction = lease.client.applyTransaction.bind(lease.client);
		let injected = false;
		vi.spyOn(lease.client, "applyTransaction").mockImplementation(async (input) => {
			if (transactionCustomTypes(input).includes(failureTrigger)) {
				injected = true;
				throw new Error("injected RFC import persistence failure");
			}
			return applyTransaction(input);
		});

		let importError: unknown;
		try {
			await runtime.importFromJsonl(snapshotPath);
		} catch (error) {
			importError = error;
		}
		expect(injected).toBe(true);
		expect(importError).toBeInstanceOf(Error);

		const adoptedRow = (
			await SessionManager.list(cwd, sessionDir, undefined, {
				includeMessageFreeDurable: true,
			})
		).find((session) => session.id === importedId);
		expect(adoptedRow).toBeDefined();
		if (!adoptedRow) throw new Error("Expected the failed import's adopted row to remain");
		const reopened = await SessionManager.open(adoptedRow.ref);
		openedManagers.push(reopened);
		const adoptedEntries: SessionEntry[] = reopened.getEntries();
		const adoptedLeaf: SessionEntry | undefined = reopened.getLeafEntry();

		expect.soft(adoptedRow.messageCount).toBe(0);
		expect.soft(adoptedEntries).toEqual([]);
		expect.soft(adoptedLeaf).toBeUndefined();
	});
});
