import { type Component, Container, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { PlanningState } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { usesAsciiPlanMarkers } from "./plan-content.ts";
import type { PlanInspectorComponent } from "./plan-inspector.ts";

export const PLAN_SPLIT_MIN_COLUMNS = 129;
export const PLAN_SPLIT_MIN_ROWS = 24;
export const PLAN_PANE_MIN_COLUMNS = 48;
export const PLAN_PANE_MAX_COLUMNS = 72;
export const PLAN_PANE_MAX_RATIO = 0.4;
export const CONVERSATION_PANE_MIN_COLUMNS = 80;
export const PLAN_PANE_DIVIDER_COLUMNS = 1;
const PANE_SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

export interface ResponsivePlanDimensions {
	conversationColumns: number;
	dividerColumns: number;
	planColumns: number;
}

/** Resolve the exact responsive contract, or return undefined for compact layout. */
export function getResponsivePlanDimensions(
	terminalColumns: number,
	terminalRows: number,
	planning: PlanningState,
): ResponsivePlanDimensions | undefined {
	if (terminalColumns < PLAN_SPLIT_MIN_COLUMNS || terminalRows < PLAN_SPLIT_MIN_ROWS) return undefined;
	if (planning.mode !== "plan" && planning.plan === null) return undefined;

	const planColumns = Math.min(
		PLAN_PANE_MAX_COLUMNS,
		Math.floor(terminalColumns * PLAN_PANE_MAX_RATIO),
		terminalColumns - PLAN_PANE_DIVIDER_COLUMNS - CONVERSATION_PANE_MIN_COLUMNS,
	);
	if (planColumns < PLAN_PANE_MIN_COLUMNS) return undefined;
	return {
		conversationColumns: terminalColumns - PLAN_PANE_DIVIDER_COLUMNS - planColumns,
		dividerColumns: PLAN_PANE_DIVIDER_COLUMNS,
		planColumns,
	};
}

type ImageBlock = { start: number; end: number };

function getImageBlocks(lines: readonly string[]): ImageBlock[] {
	const blocks: ImageBlock[] = [];
	for (const [index, line] of lines.entries()) {
		const kittyStart = line.indexOf("\x1b_G");
		if (kittyStart !== -1) {
			const paramsEnd = line.indexOf(";", kittyStart + 3);
			const params = paramsEnd === -1 ? "" : line.slice(kittyStart + 3, paramsEnd);
			const rowParam = params.split(",").find((param) => param.startsWith("r="));
			const rows = rowParam ? Number(rowParam.slice(2)) : 1;
			const safeRows = Number.isSafeInteger(rows) && rows > 0 ? rows : 1;
			blocks.push({ start: index, end: Math.min(lines.length - 1, index + safeRows - 1) });
			continue;
		}
		if (line.includes("\x1b]1337;File=")) {
			const prefix = line.slice(0, line.indexOf("\x1b]1337;File="));
			const cursorUpMatches = [...prefix.matchAll(/\x1b\[(\d+)A/g)];
			const lastCursorUp = cursorUpMatches[cursorUpMatches.length - 1]?.[1];
			const rowsBefore = lastCursorUp === undefined ? 0 : Number(lastCursorUp);
			blocks.push({ start: Math.max(0, index - rowsBefore), end: index });
		}
	}
	return blocks;
}

function protectedImageRows(lines: readonly string[]): Set<number> {
	const rows = new Set<number>();
	for (const block of getImageBlocks(lines)) {
		for (let index = block.start; index <= block.end; index++) rows.add(index);
	}
	return rows;
}

function safeTailStart(lines: readonly string[], maximumRows: number, minimumStart = 0): number {
	let start = Math.min(lines.length, Math.max(minimumStart, lines.length - Math.max(0, maximumRows)));
	for (const block of getImageBlocks(lines)) {
		if (start > block.start && start <= block.end) {
			start = block.end + 1;
		}
	}
	return start;
}

function renderComponents(components: readonly Component[], width: number): string[] {
	return components.flatMap((component) => component.render(width));
}

function fitLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

/**
 * Main interactive viewport. Compact terminals retain the legacy vertical flow;
 * wide terminals keep conversation controls and the canonical plan inspector in
 * the active viewport while leaving older conversation rows in scrollback.
 */
export class ResponsivePlanLayoutComponent extends Container {
	private planning: PlanningState;
	private footer: Component;
	private readonly transcriptComponents: readonly Component[];
	private readonly controlComponents: readonly Component[];
	private readonly compactComponents: readonly Component[];
	private readonly inspector: PlanInspectorComponent;
	private readonly getTerminalRows: () => number;
	private readonly requestViewportReset: () => void;
	private readonly onSplitChange: (split: boolean, preserveScrollback: boolean) => void;
	private lastSplit: boolean | undefined;
	private lastWidth: number | undefined;
	private lastRows: number | undefined;
	private committedTranscriptStart: number | undefined;
	private previousCommittedTranscript: readonly string[] | undefined;
	private previousTranscriptRows: number | undefined;

	constructor(options: {
		planning: PlanningState;
		transcriptComponents: readonly Component[];
		controlComponents: readonly Component[];
		compactComponents: readonly Component[];
		inspector: PlanInspectorComponent;
		footer: Component;
		getTerminalRows: () => number;
		requestViewportReset: () => void;
		onSplitChange: (split: boolean, preserveScrollback: boolean) => void;
	}) {
		super();
		this.planning = options.planning;
		this.transcriptComponents = options.transcriptComponents;
		this.controlComponents = options.controlComponents;
		this.compactComponents = options.compactComponents;
		this.inspector = options.inspector;
		this.footer = options.footer;
		this.getTerminalRows = options.getTerminalRows;
		this.requestViewportReset = options.requestViewportReset;
		this.onSplitChange = options.onSplitChange;
		this.rebuildChildren();
	}

	setPlanning(planning: PlanningState): void {
		this.planning = planning;
	}

	setFooter(footer: Component): void {
		this.footer = footer;
		this.rebuildChildren();
	}

	isSplit(width: number, rows = this.getTerminalRows()): boolean {
		return getResponsivePlanDimensions(width, rows, this.planning) !== undefined;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const rows = this.getTerminalRows();
		const dimensions = getResponsivePlanDimensions(width, rows, this.planning);
		const split = dimensions !== undefined;
		const resetCommittedTranscript = this.lastSplit !== true || this.lastWidth !== width || this.lastRows !== rows;
		if (this.lastSplit !== undefined && this.lastSplit !== split) {
			this.onSplitChange(split, this.lastWidth === width && this.lastRows === rows);
		}
		this.lastSplit = split;
		this.lastWidth = width;
		this.lastRows = rows;
		const footerLines = this.footer.render(width);
		if (!dimensions) {
			this.committedTranscriptStart = undefined;
			this.previousCommittedTranscript = undefined;
			this.previousTranscriptRows = undefined;
			return [...renderComponents(this.compactComponents, width), ...footerLines];
		}
		if (resetCommittedTranscript) {
			this.committedTranscriptStart = undefined;
			this.previousCommittedTranscript = undefined;
			this.previousTranscriptRows = undefined;
		}

		const mainRows = Math.max(0, rows - footerLines.length);
		if (mainRows === 0) return footerLines;
		const transcript = renderComponents(this.transcriptComponents, dimensions.conversationColumns);
		const controls = renderComponents(this.controlComponents, dimensions.conversationColumns);
		const controlStart = safeTailStart(controls, mainRows);
		const visibleControls = controls.slice(controlStart);
		const transcriptRows = Math.max(0, mainRows - visibleControls.length);
		if (
			this.previousTranscriptRows !== undefined &&
			transcript.length < this.previousTranscriptRows &&
			this.committedTranscriptStart !== undefined &&
			this.previousCommittedTranscript !== undefined &&
			(transcript.length < this.committedTranscriptStart ||
				this.previousCommittedTranscript.length !== this.committedTranscriptStart ||
				this.previousCommittedTranscript.some((line, index) => transcript[index] !== line))
		) {
			this.requestViewportReset();
			this.committedTranscriptStart = undefined;
		}
		const transcriptStart = safeTailStart(transcript, transcriptRows, this.committedTranscriptStart);
		this.committedTranscriptStart = transcriptStart;
		this.previousCommittedTranscript = transcript.slice(0, transcriptStart);
		this.previousTranscriptRows = transcript.length;
		const historicalTranscript = transcript.slice(0, transcriptStart);
		const protectedHistoricalRows = protectedImageRows(historicalTranscript);
		const visibleTranscript = transcript.slice(transcriptStart);
		const padding = Array.from({ length: Math.max(0, transcriptRows - visibleTranscript.length) }, () => "");
		const visibleConversation = [...visibleTranscript, ...padding, ...visibleControls].slice(-mainRows);
		const protectedVisibleRows = protectedImageRows(visibleConversation);
		const availableInspectorRows = Math.max(0, mainRows - protectedVisibleRows.size);
		this.inspector.setViewportRows(availableInspectorRows);
		const inspectorLines = this.inspector.render(dimensions.planColumns);
		const divider = theme.fg("border", usesAsciiPlanMarkers() ? "|" : "│");
		let inspectorIndex = 0;
		const visibleLines = visibleConversation.map((line, index) => {
			if (protectedVisibleRows.has(index)) return line;
			const right = inspectorLines[inspectorIndex++] ?? "";
			return `${fitLine(line, dimensions.conversationColumns)}${PANE_SEGMENT_RESET}${divider}${fitLine(right, dimensions.planColumns)}`;
		});
		// Rows scrolled out of the active viewport become immutable terminal scrollback. The plan
		// pane only ever exists in the viewport, so decorating them with a divider would strand a
		// dangling column beside empty space forever. Emit them as plain conversation text instead.
		const historicalLines = historicalTranscript.map((line, index) =>
			protectedHistoricalRows.has(index) ? line : truncateToWidth(line, dimensions.conversationColumns, ""),
		);
		return [...historicalLines, ...visibleLines, ...footerLines];
	}

	private rebuildChildren(): void {
		this.children = [...new Set([...this.compactComponents, this.inspector, this.footer])];
	}
}
