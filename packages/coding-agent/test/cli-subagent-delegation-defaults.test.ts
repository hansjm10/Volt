import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { SubagentManager } from "../src/core/subagents/index.ts";
import { main } from "../src/main.ts";

const ENV_KEYS = [
	"HOME",
	"VOLT_CODING_AGENT_DIR",
	"VOLT_CODING_AGENT_SESSION_DIR",
	"VOLT_OFFLINE",
	"VOLT_SKIP_VERSION_CHECK",
] as const;

function expectDefaultTurnStagesAndUnlimitedUsageBudgets(manager: SubagentManager): void {
	const turnLease = manager.createDelegationScope();
	expect(turnLease.owned).toBe(true);
	let turnDescendantAborted = false;
	const turnReservation = turnLease.scope.reserve("turn-probe", 1);
	turnReservation.commit("sa_cli-turn-probe", () => {
		turnDescendantAborted = true;
	});
	for (let turn = 1; turn < 80; turn += 1) {
		expect(turnLease.scope.recordTurn()).toBeUndefined();
	}
	expect(turnLease.scope.recordTurn()).toMatchObject({ stage: "warning", turnsUsed: 80, maxTurns: 120 });
	for (let turn = 81; turn < 120; turn += 1) {
		expect(turnLease.scope.recordTurn()).toBeUndefined();
	}
	expect(turnLease.scope.recordTurn()).toMatchObject({ stage: "final-report", turnsUsed: 120, maxTurns: 120 });
	expect(turnLease.scope.signal.aborted).toBe(false);
	expect(turnDescendantAborted).toBe(false);
	turnReservation.release();
	turnLease.scope.dispose();

	const cases: Array<{
		name: string;
		consume(scope: ReturnType<SubagentManager["createDelegationScope"]>["scope"]): void;
	}> = [
		{ name: "tokens", consume: (scope) => scope.recordUsage(50_000_001, 0) },
		{ name: "cost", consume: (scope) => scope.recordUsage(0, 100.01) },
	];

	for (const testCase of cases) {
		const lease = manager.createDelegationScope();
		expect(lease.owned).toBe(true);
		let descendantAborted = false;
		const reservation = lease.scope.reserve(`${testCase.name}-probe`, 1);
		reservation.commit(`sa_cli-${testCase.name}-probe`, () => {
			descendantAborted = true;
		});

		testCase.consume(lease.scope);

		expect(lease.scope.signal.aborted).toBe(false);
		expect(descendantAborted).toBe(false);
		reservation.release();
		lease.scope.dispose();
	}
}

it("uses staged CLI turn defaults while leaving token and cost budgets unlimited", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "volt-cli-subagent-defaults-"));
	const workspace = join(tempDir, "workspace");
	const agentDir = join(tempDir, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const previousCwd = process.cwd();
	const previousExitCode = process.exitCode;
	const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
		(typeof ENV_KEYS)[number],
		string | undefined
	>;
	const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const faux = registerFauxProvider();
	const model = faux.getModel();
	faux.setResponses([fauxAssistantMessage("")]);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				[model.provider]: {
					api: faux.api,
					apiKey: "faux-key",
					baseUrl: "http://localhost:0",
					models: faux.models,
				},
			},
		})}\n`,
	);
	let inspectedManager = false;
	const getSubagentToolManager = AgentSession.prototype.getSubagentToolManager;
	vi.spyOn(AgentSession.prototype, "getSubagentToolManager").mockImplementation(function (this: AgentSession) {
		const manager = getSubagentToolManager.call(this);
		if (!inspectedManager && manager instanceof SubagentManager) {
			expectDefaultTurnStagesAndUnlimitedUsageBudgets(manager);
			inspectedManager = true;
		}
		return manager;
	});

	try {
		process.chdir(workspace);
		process.env.HOME = tempDir;
		process.env.VOLT_CODING_AGENT_DIR = agentDir;
		process.env.VOLT_CODING_AGENT_SESSION_DIR = join(tempDir, "sessions");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

		await main([
			"--print",
			"--offline",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--provider",
			model.provider,
			"--model",
			model.id,
			"--api-key",
			"faux-key",
			"inspect subagent defaults",
		]);

		expect(inspectedManager).toBe(true);
	} finally {
		restoreStdout();
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		for (const key of ENV_KEYS) {
			const value = previousEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		if (stdinIsTTYDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
		} else {
			Reflect.deleteProperty(process.stdin, "isTTY");
		}
		vi.restoreAllMocks();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
