export interface SubagentTurnLimits {
	/** Assistant turns in one child runtime before it receives a wrap-up warning. */
	warnAtTurns?: number;
	/** Assistant turns in one child runtime before it must return a tool-free final report. */
	maxTurns?: number;
}

export const DEFAULT_SUBAGENT_TURN_LIMITS: Required<SubagentTurnLimits> = {
	warnAtTurns: 80,
	maxTurns: 120,
};

export interface SubagentTurnBudgetEvent {
	stage: "warning" | "final-report" | "exceeded";
	turnsUsed: number;
	warnAtTurns: number;
	maxTurns: number;
}

export function resolveSubagentTurnLimits(overrides: SubagentTurnLimits | undefined): Required<SubagentTurnLimits> {
	const limits: Required<SubagentTurnLimits> = { ...DEFAULT_SUBAGENT_TURN_LIMITS };
	for (const key of Object.keys(limits) as Array<keyof SubagentTurnLimits>) {
		const value = overrides?.[key];
		if (value === undefined) {
			continue;
		}
		if (value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value <= 0)) {
			throw new Error(`Subagent turn limit ${key} must be a positive safe integer or Infinity`);
		}
		limits[key] = value;
	}
	if (overrides?.maxTurns === Number.POSITIVE_INFINITY && overrides.warnAtTurns === undefined) {
		limits.warnAtTurns = Number.POSITIVE_INFINITY;
	}
	return limits;
}

export class SubagentTurnBudget {
	readonly limits: Required<SubagentTurnLimits>;
	private turnsUsed = 0;

	constructor(limits: SubagentTurnLimits | undefined) {
		this.limits = resolveSubagentTurnLimits(limits);
	}

	recordTurn(): SubagentTurnBudgetEvent | undefined {
		this.turnsUsed += 1;
		if (this.turnsUsed > this.limits.maxTurns) {
			return this.event("exceeded");
		}
		if (this.turnsUsed === this.limits.maxTurns) {
			return this.event("final-report");
		}
		if (this.turnsUsed === this.limits.warnAtTurns) {
			return this.event("warning");
		}
		return undefined;
	}

	private event(stage: SubagentTurnBudgetEvent["stage"]): SubagentTurnBudgetEvent {
		return {
			stage,
			turnsUsed: this.turnsUsed,
			warnAtTurns: this.limits.warnAtTurns,
			maxTurns: this.limits.maxTurns,
		};
	}
}
