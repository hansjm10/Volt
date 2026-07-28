export type SubagentSpawnCapacityMode = "single" | "parallel" | "chain";
export type SubagentSpawnCapacityPhase = "advisory" | "admitted" | "admission-rejected";

/** Machine-readable reasons why a proposed spawn batch cannot be admitted. */
export type SubagentSpawnCapacityConstraint =
	| "caller-max-child-agents"
	| "caller-max-subagent-depth"
	| "tree-max-starts"
	| "tree-max-active-descendants"
	| "tree-max-depth"
	| "delegation-scope-aborted"
	| "delegation-scope-disposed";

/** JSON-safe capacity counter. `null` means the maximum or remaining capacity is unlimited. */
export interface SubagentCapacityLimitSnapshot {
	maximum: number | null;
	used: number;
	reserved: number;
	remaining: number | null;
}

/** Current runtime depth and its inherited local delegation-depth cap. */
export interface SubagentCallerDepthCapacitySnapshot {
	maximum: number | null;
	used: number;
	reserved: number;
	remaining: number | null;
}

export interface SubagentSpawnCapacityProposal {
	mode: SubagentSpawnCapacityMode;
	requestedStarts: number;
	peakConcurrentStarts: number;
}

export interface SubagentTreeCapacitySnapshot {
	maxStarts: SubagentCapacityLimitSnapshot;
	maxActiveDescendants: SubagentCapacityLimitSnapshot;
	maxDepth: SubagentCapacityLimitSnapshot;
	aborted: boolean;
	disposed: boolean;
}

/** Structured, JSON-safe admission view for one exact spawn request. */
export interface SubagentSpawnCapacitySnapshot {
	phase: SubagentSpawnCapacityPhase;
	proposal: SubagentSpawnCapacityProposal;
	caller: {
		maxChildAgents: SubagentCapacityLimitSnapshot;
		depth: SubagentCallerDepthCapacitySnapshot;
	};
	tree: SubagentTreeCapacitySnapshot;
	fits: boolean;
	constraints: SubagentSpawnCapacityConstraint[];
}
