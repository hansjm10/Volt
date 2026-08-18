import {
	type Component,
	Container,
	concatRenderFrames,
	createRenderFrame,
	HStack,
	mapRenderFrameLines,
	type RenderFrame,
	sliceRenderFrame,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
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
const CONVERSATION_PANE_BASIS_COLUMNS = 108;
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

function protectedImageRows(frame: RenderFrame): Set<number> {
	const rows = new Set<number>();
	for (const image of frame.images) {
		const end = Math.min(frame.lines.length, image.top + image.rows);
		for (let row = Math.max(0, image.top); row < end; row++) rows.add(row);
	}
	return rows;
}

function safeTailStart(frame: RenderFrame, maximumRows: number, minimumStart = 0): number {
	let start = Math.min(frame.lines.length, Math.max(minimumStart, frame.lines.length - Math.max(0, maximumRows)));
	while (true) {
		let nextStart = start;
		for (const image of frame.images) {
			const end = Math.min(frame.lines.length, image.top + image.rows);
			if (image.top < start && start < end) nextStart = Math.max(nextStart, end);
		}
		if (nextStart === start) return start;
		start = nextStart;
	}
}

function renderComponents(components: readonly Component[], width: number): RenderFrame {
	return concatRenderFrames(components.map((component) => component.render(width)));
}

function fitLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

class PlanPaneDivider implements Component {
	private readonly getTerminalRows: () => number;

	constructor(getTerminalRows: () => number) {
		this.getTerminalRows = getTerminalRows;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const divider = theme.fg("border", usesAsciiPlanMarkers() ? "|" : "│");
		return createRenderFrame(Array.from({ length: Math.max(1, this.getTerminalRows()) }, () => divider));
	}
}

/**
 * Renderer-aware interactive plan layout. Main-screen mode preserves native
 * terminal scrollback; fullscreen mode uses constrained stacks and scroll views.
 */
export class ResponsivePlanLayoutComponent extends Container {
	private planning: PlanningState;
	private readonly footer: Component;
	private readonly transcriptComponents: readonly Component[];
	private readonly controlComponents: readonly Component[];
	private readonly compactComponents: readonly Component[];
	private readonly inspector: PlanInspectorComponent;
	private readonly getTerminalColumns: () => number;
	private readonly getTerminalRows: () => number;
	private readonly requestViewportReset: () => void;
	private readonly onSplitChange: (split: boolean, preserveScrollback: boolean) => void;
	private readonly fullscreenRoot: VStack;
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
		fullscreenConversation: Component;
		inspector: PlanInspectorComponent;
		footer: Component;
		getTerminalColumns: () => number;
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
		this.getTerminalColumns = options.getTerminalColumns;
		this.getTerminalRows = options.getTerminalRows;
		this.requestViewportReset = options.requestViewportReset;
		this.onSplitChange = options.onSplitChange;

		const fullscreenSplit = new HStack([
			{
				component: options.fullscreenConversation,
				basis: CONVERSATION_PANE_BASIS_COLUMNS,
				grow: 1,
				shrink: 1,
				minSize: CONVERSATION_PANE_MIN_COLUMNS,
			},
			{
				component: new PlanPaneDivider(options.getTerminalRows),
				basis: PLAN_PANE_DIVIDER_COLUMNS,
				grow: 0,
				shrink: 0,
				minSize: PLAN_PANE_DIVIDER_COLUMNS,
				maxSize: PLAN_PANE_DIVIDER_COLUMNS,
			},
			{
				component: this.inspector.getFullscreenLayout(),
				basis: PLAN_PANE_MAX_COLUMNS,
				grow: 0,
				shrink: 1,
				minSize: PLAN_PANE_MIN_COLUMNS,
				maxSize: PLAN_PANE_MAX_COLUMNS,
			},
		]);
		const fullscreenBody = new VStack([
			{
				component: options.fullscreenConversation,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 0,
				visible: (viewport) => !this.resolveFullscreenSplit(viewport.width, viewport.height),
			},
			{
				component: fullscreenSplit,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 0,
				visible: (viewport) => this.resolveFullscreenSplit(viewport.width, viewport.height),
			},
		]);
		this.fullscreenRoot = new VStack([
			{ component: fullscreenBody, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: this.footer, shrink: 1, minSize: 0 },
		]);
		this.children = [...new Set([...this.compactComponents, this.inspector, this.footer])];
	}

	setPlanning(planning: PlanningState): void {
		this.planning = planning;
	}

	isSplit(width: number, rows = this.getTerminalRows()): boolean {
		return getResponsivePlanDimensions(width, rows, this.planning) !== undefined;
	}

	isTerminalSplit(): boolean {
		return this.isSplit(this.getTerminalColumns(), this.getTerminalRows());
	}

	getFullscreenLayout(): Component {
		return this.fullscreenRoot;
	}

	override render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const rows = this.getTerminalRows();
		const dimensions = getResponsivePlanDimensions(width, rows, this.planning);
		const split = dimensions !== undefined;
		const resetCommittedTranscript = this.lastSplit !== true || this.lastWidth !== width || this.lastRows !== rows;
		this.syncSplit(split, this.lastWidth === width);
		this.lastWidth = width;
		this.lastRows = rows;
		const footerFrame = this.footer.render(width);
		if (!dimensions) {
			this.committedTranscriptStart = undefined;
			this.previousCommittedTranscript = undefined;
			this.previousTranscriptRows = undefined;
			return concatRenderFrames([renderComponents(this.compactComponents, width), footerFrame]);
		}
		if (resetCommittedTranscript) {
			this.committedTranscriptStart = undefined;
			this.previousCommittedTranscript = undefined;
			this.previousTranscriptRows = undefined;
		}

		const mainRows = Math.max(0, rows - footerFrame.lines.length);
		if (mainRows === 0) return footerFrame;
		const transcript = renderComponents(this.transcriptComponents, dimensions.conversationColumns);
		const controls = renderComponents(this.controlComponents, dimensions.conversationColumns);
		const controlStart = safeTailStart(controls, mainRows);
		const visibleControls = sliceRenderFrame(controls, controlStart);
		const transcriptRows = Math.max(0, mainRows - visibleControls.lines.length);
		if (
			this.previousTranscriptRows !== undefined &&
			transcript.lines.length < this.previousTranscriptRows &&
			this.committedTranscriptStart !== undefined &&
			this.previousCommittedTranscript !== undefined &&
			(transcript.lines.length < this.committedTranscriptStart ||
				this.previousCommittedTranscript.length !== this.committedTranscriptStart ||
				this.previousCommittedTranscript.some((line, index) => transcript.lines[index] !== line))
		) {
			this.requestViewportReset();
			this.committedTranscriptStart = undefined;
		}
		const transcriptStart = safeTailStart(transcript, transcriptRows, this.committedTranscriptStart);
		this.committedTranscriptStart = transcriptStart;
		this.previousCommittedTranscript = transcript.lines.slice(0, transcriptStart);
		this.previousTranscriptRows = transcript.lines.length;
		const historicalTranscript = sliceRenderFrame(transcript, 0, transcriptStart);
		const protectedHistoricalRows = protectedImageRows(historicalTranscript);
		const visibleTranscript = sliceRenderFrame(transcript, transcriptStart);
		const padding = createRenderFrame(
			Array.from({ length: Math.max(0, transcriptRows - visibleTranscript.lines.length) }, () => ""),
		);
		const visibleConversation = concatRenderFrames([visibleTranscript, padding, visibleControls]);
		const protectedVisibleRows = protectedImageRows(visibleConversation);
		const availableInspectorRows = Math.max(0, mainRows - protectedVisibleRows.size);
		this.inspector.setViewportRows(availableInspectorRows);
		const inspectorFrame = this.inspector.render(dimensions.planColumns);
		const divider = theme.fg("border", usesAsciiPlanMarkers() ? "|" : "│");
		let inspectorIndex = 0;
		const visibleFrame = mapRenderFrameLines(visibleConversation, (line, row) => {
			if (protectedVisibleRows.has(row)) return line;
			const right = inspectorFrame.lines[inspectorIndex++] ?? "";
			return `${fitLine(line, dimensions.conversationColumns)}${PANE_SEGMENT_RESET}${divider}${fitLine(right, dimensions.planColumns)}`;
		});
		const historicalFrame = mapRenderFrameLines(historicalTranscript, (line, row) =>
			protectedHistoricalRows.has(row) ? line : truncateToWidth(line, dimensions.conversationColumns, ""),
		);
		return concatRenderFrames([historicalFrame, visibleFrame, footerFrame]);
	}

	private resolveFullscreenSplit(width: number, rows: number): boolean {
		const split = this.isSplit(width, rows);
		this.syncSplit(split, false);
		this.lastWidth = width;
		this.lastRows = rows;
		return split;
	}

	private syncSplit(split: boolean, preserveScrollback: boolean): void {
		const previous = this.lastSplit;
		this.lastSplit = split;
		if (previous !== undefined && previous !== split) this.onSplitChange(split, preserveScrollback);
	}
}
