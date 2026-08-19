import {
	Box,
	type Component,
	Container,
	concatRenderFrames,
	createRenderFrame,
	getCapabilities,
	Image,
	mapRenderFrameLines,
	type RenderFrame,
	Spacer,
	spliceRenderFrameRows,
	Text,
	type TUI,
	visibleWidth,
} from "@hansjm10/volt-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { formatDuration, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

function hasCreatedSubagent(details: unknown): boolean {
	if (typeof details !== "object" || details === null || Array.isArray(details)) {
		return false;
	}
	const record = details as Record<string, unknown>;
	if (record.mode !== "single" && record.mode !== "parallel" && record.mode !== "chain") {
		return false;
	}
	const hasSubagentId = (value: unknown): boolean =>
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).subagentId === "string";
	if (hasSubagentId(record)) {
		return true;
	}
	if (Array.isArray(record.childSessions) && record.childSessions.some(hasSubagentId)) {
		return true;
	}
	const tasks = record.mode === "chain" ? record.steps : record.tasks;
	return Array.isArray(tasks) && tasks.some(hasSubagentId);
}

/**
 * Wraps a tool call renderer and appends explicit lifecycle metadata to its
 * first non-empty line. If the metadata does not fit, it gets its own line so
 * state is never communicated by color alone.
 */
class ToolHeaderMetadata implements Component {
	private component: Component;
	private getMetadata: () => string;

	constructor(component: Component, getMetadata: () => string) {
		this.component = component;
		this.getMetadata = getMetadata;
	}

	render(width: number): RenderFrame {
		const frame = this.component.render(width);
		if (frame.lines.length === 0) return frame;
		// Components like Text pad lines to full width with trailing spaces;
		// strip that padding before measuring (the parent Box re-pads).
		const index = frame.lines.findIndex((line) => visibleWidth(line.replace(/ +$/, "")) > 0);
		if (index === -1) return frame;
		const line = frame.lines[index]!.replace(/ +$/, "");
		const metadata = this.getMetadata();
		const image = frame.images.find((placement) => index >= placement.top && index < placement.top + placement.rows);
		if (image) {
			return spliceRenderFrameRows(
				frame,
				Math.min(frame.lines.length, image.top + image.rows),
				0,
				createRenderFrame([metadata]),
			);
		}
		if (visibleWidth(line) + visibleWidth(metadata) + 1 <= width) {
			return mapRenderFrameLines(frame, (value, row) => (row === index ? `${line} ${metadata}` : value));
		}
		return spliceRenderFrameRows(frame, index + 1, 0, createRenderFrame([metadata]));
	}

	invalidate(): void {
		this.component.invalidate?.();
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private executionStartedAt?: number;
	private executionDurationMs?: number;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages = new Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	>();
	private pendingImageConversions = new Map<string, Map<string, Promise<{ data: string; mimeType: string } | null>>>();
	private disposed = false;
	private hideComponent = false;
	private subagentCreationObserved = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 0);
		this.contentText = new Text("", 1, 0);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	/** Collapsed line budget for tools without their own result renderer. */
	private static readonly FALLBACK_COLLAPSED_LINES = 10;

	/**
	 * Collapse fallback output to a line budget when not expanded, appending the
	 * standard "... (N more lines, ctrl+o to expand)" hint used by built-in tools.
	 */
	private collapseFallbackOutput(output: string, colorFn?: (line: string) => string): string {
		const lines = output.split("\n");
		const maxLines = this.expanded ? lines.length : ToolExecutionComponent.FALLBACK_COLLAPSED_LINES;
		const displayLines = lines.slice(0, maxLines);
		const rendered = colorFn ? displayLines.map(colorFn).join("\n") : displayLines.join("\n");
		const remaining = lines.length - displayLines.length;
		if (remaining <= 0) {
			return rendered;
		}
		return `${rendered}\n${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(
			this.collapseFallbackOutput(output, (line) => theme.fg("toolOutput", line)),
			0,
			0,
		);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStartedAt ??= Date.now();
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		if (this.disposed) return;
		if (this.toolName === "subagent" && hasCreatedSubagent(result.details)) {
			this.subagentCreationObserved = true;
		}
		if (!isPartial && this.executionStartedAt !== undefined && this.executionDurationMs === undefined) {
			this.executionDurationMs = Date.now() - this.executionStartedAt;
		}
		this.result = result;
		this.isPartial = isPartial;
		const imageBlocks = result.content.filter((content) => content.type === "image");
		for (const [index, converted] of this.convertedImages) {
			const source = imageBlocks[index];
			if (source?.data !== converted.sourceData || source.mimeType !== converted.sourceMimeType) {
				this.convertedImages.delete(index);
			}
		}
		this.updateDisplay();
		this.maybeConvertImagesForTerminal();
	}

	private maybeConvertImagesForTerminal(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty" && caps.images !== "sixel") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((content) => content.type === "image");
		for (let index = 0; index < imageBlocks.length; index++) {
			const img = imageBlocks[index];
			if (!img?.data || !img.mimeType || img.mimeType === "image/png") continue;
			const existing = [...this.convertedImages.values()].find(
				(converted) => converted.sourceData === img.data && converted.sourceMimeType === img.mimeType,
			);
			if (existing) {
				this.convertedImages.set(index, existing);
				continue;
			}
			let conversionsForMime = this.pendingImageConversions.get(img.mimeType);
			if (!conversionsForMime) {
				conversionsForMime = new Map();
				this.pendingImageConversions.set(img.mimeType, conversionsForMime);
			}
			if (conversionsForMime.has(img.data)) continue;

			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			const conversion = convertToPng(sourceData, sourceMimeType);
			conversionsForMime.set(sourceData, conversion);
			conversion
				.then((converted) => {
					if (!converted || this.disposed || !this.result) return;
					let changed = false;
					const currentImages = this.result.content.filter((content) => content.type === "image");
					for (let index = 0; index < currentImages.length; index++) {
						const current = currentImages[index];
						if (current?.data !== sourceData || current.mimeType !== sourceMimeType) continue;
						this.convertedImages.set(index, { sourceData, sourceMimeType, ...converted });
						changed = true;
					}
					if (!changed) return;
					this.updateDisplay();
					this.ui.requestRender();
				})
				.catch(() => {})
				.finally(() => {
					if (this.disposed) return;
					if (conversionsForMime?.get(sourceData) === conversion) conversionsForMime.delete(sourceData);
					if (conversionsForMime?.size === 0) this.pendingImageConversions.delete(sourceMimeType);
				});
		}
	}

	/**
	 * Release renderer resources (e.g. the subagent repaint interval) when the
	 * host discards this row before a terminal render. Safe to call repeatedly.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.releaseImageComponents();
		this.convertedImages.clear();
		this.pendingImageConversions.clear();
		this.toolDefinition?.disposeRenderState?.(this.rendererState);
		if (this.builtInToolDefinition !== this.toolDefinition) {
			this.builtInToolDefinition?.disposeRenderState?.(this.rendererState);
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
		this.maybeConvertImagesForTerminal();
	}

	override render(width: number): RenderFrame {
		if (this.hideComponent) {
			return createRenderFrame([]);
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentFrame = this.selfRenderContainer.render(width);
			if (contentFrame.lines.length === 0 && this.imageComponents.length === 0) return createRenderFrame([]);

			const frames: RenderFrame[] = [];
			if (contentFrame.lines.length > 0) frames.push(createRenderFrame([""]), contentFrame);
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) frames.push(spacer.render(width));
				const imageComponent = this.imageComponents[i];
				if (imageComponent) frames.push(imageComponent.render(width));
			}
			return concatRenderFrames(frames);
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.withHeaderMetadata(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.withHeaderMetadata(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.withHeaderMetadata(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
			if (this.toolName === "subagent") {
				const outputs = keyHint("app.tools.expand", this.expanded ? "collapse outputs" : "outputs");
				renderContainer.addChild(new Text(`${keyHint("app.subagents.open", "inspect")}  ${outputs}`, 0, 0));
				hasContent = true;
			}
		} else {
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		this.releaseImageComponents();

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if ((caps.images === "kitty" || caps.images === "sixel") && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
		if (this.toolName === "subagent" && !this.subagentCreationObserved && !this.shouldPresentWithoutCreation()) {
			this.hideComponent = true;
		}
	}

	/**
	 * Subagent rows without a created child stay hidden only for spawn
	 * preflights: explicit registry queries, terminal errors, and settled spawn
	 * executions (e.g. every child failed to start) must render normally.
	 */
	private releaseImageComponents(): void {
		for (const image of this.imageComponents) {
			image.dispose();
			this.removeChild(image);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) this.removeChild(spacer);
		this.imageSpacers = [];
	}

	private shouldPresentWithoutCreation(): boolean {
		const args = this.args as Record<string, unknown> | null | undefined;
		if (args && typeof args === "object" && (args.list !== undefined || args.follow !== undefined)) {
			return true;
		}
		if (!this.result || this.isPartial) {
			return false;
		}
		if (this.result.isError) {
			return true;
		}
		const mode = (this.result.details as { mode?: unknown } | undefined)?.mode;
		return mode === "single" || mode === "parallel" || mode === "chain";
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	/** Minimum completed duration before the tool header shows a duration suffix. */
	private static readonly DURATION_DISPLAY_THRESHOLD_MS = 1000;

	private withHeaderMetadata(component: Component): Component {
		// Subagents render as conversation participants with their own explicit
		// lifecycle state instead of as a generic tool card.
		if (this.toolName === "subagent") return component;
		return new ToolHeaderMetadata(component, () => this.getHeaderMetadata());
	}

	private getHeaderMetadata(): string {
		let state: string;
		if (this.result?.isError) {
			state = theme.fg("error", "[failure]");
		} else if (this.result && this.isPartial) {
			state = theme.fg("warning", "[partial]");
		} else if (this.result) {
			state = theme.fg("success", "[success]");
		} else if (this.executionStarted) {
			state = theme.fg("warning", "[running]");
		} else {
			state = theme.fg("muted", "[pending]");
		}

		const duration = this.getDurationSuffix();
		return duration ? `${state} ${duration}` : state;
	}

	private getDurationSuffix(): string | undefined {
		if (
			this.executionDurationMs === undefined ||
			this.executionDurationMs < ToolExecutionComponent.DURATION_DISPLAY_THRESHOLD_MS ||
			this.rendersOwnDuration()
		) {
			return undefined;
		}
		return theme.fg("dim", `(${formatDuration(this.executionDurationMs)})`);
	}

	/**
	 * Whether the active result renderer already displays its own duration
	 * (e.g. the built-in bash tool's "Elapsed/Took" line), indicated by the
	 * rendersDuration flag on the definition that provides the renderer.
	 */
	private rendersOwnDuration(): boolean {
		if (this.toolDefinition?.renderResult) {
			return this.toolDefinition.rendersDuration === true;
		}
		return this.builtInToolDefinition?.rendersDuration === true;
	}

	private formatToolExecution(): string {
		let text = `${theme.fg("toolTitle", theme.bold(this.toolName))} ${this.getHeaderMetadata()}`;
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${this.collapseFallbackOutput(output)}`;
		}
		return text;
	}
}
