import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { DEFAULT_SUBAGENT_TURN_LIMITS, SubagentManager } from "../src/core/subagents/index.ts";
import { main } from "../src/main.ts";

const ENV_KEYS = [
	"HOME",
	"VOLT_CODING_AGENT_DIR",
	"VOLT_CODING_AGENT_SESSION_DIR",
	"VOLT_OFFLINE",
	"VOLT_SKIP_VERSION_CHECK",
] as const;

function expectDefaultPerRuntimeTurnStagesAndUnlimitedAggregateBudgets(manager: SubagentManager): void {
	const configuredScope = manager.createDelegationScope();
	expect(configuredScope.owned).toBe(true);
	expect(configuredScope.scope.turnLimits).toEqual(DEFAULT_SUBAGENT_TURN_LIMITS);
	configuredScope.scope.dispose();

	const cases: Array<{
		name: string;
		consume(scope: ReturnType<SubagentManager["createDelegationScope"]>["scope"]): void;
	}> = [
		{
			name: "turns",
			consume: (scope) => {
				for (let turn = 0; turn < 1_000; turn += 1) scope.recordTurn();
			},
		},
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

it("uses per-runtime CLI turn defaults while leaving aggregate consumption budgets unlimited", async () => {
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
	const disposeSubagentToolManager = AgentSession.prototype.disposeSubagentToolManager;
	vi.spyOn(AgentSession.prototype, "disposeSubagentToolManager").mockImplementation(async function (
		this: AgentSession,
	) {
		if (!inspectedManager) {
			const manager = this.getSubagentToolManager();
			if (manager instanceof SubagentManager) {
				expectDefaultPerRuntimeTurnStagesAndUnlimitedAggregateBudgets(manager);
				inspectedManager = true;
			}
		}
		await disposeSubagentToolManager.call(this);
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
