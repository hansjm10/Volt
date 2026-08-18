import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	Container,
	createRenderFrame,
	type Component,
	type RenderFrame,
	type Terminal,
	type TUI,
	TuiMainScreen,
} from "@hansjm10/volt-tui";
import { initTheme } from "../src/core/theme/runtime.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	StreamingRenderCoalescer,
	type StreamingRenderScheduler,
} from "../src/modes/interactive/components/streaming-render-coalescer.ts";

const WIDTH = 120;
const HEIGHT = 36;
const CHUNK_INTERVAL_MS = 10;
const HISTORY_LINE_COUNTS = [0, 1_000, 10_000] as const;
const STREAM_PARTS = [
	"# Streaming benchmark\n\n",
	"This response exercises **formatted text**, ",
	"inline `code`, and [links](https://example.com).\n\n",
	"> A quoted observation\n",
	"> with a continuation.\n\n",
	"1. First item\n",
	"2. Second item\n",
	"   - Nested item\n\n",
	"```ts\n",
	"export function add(left: number, right: number) {\n",
	"  return left + right;\n",
	"}\n",
	"```\n\n",
	"| Metric | Value |\n",
	"| --- | ---: |\n",
	"| frames | bounded |\n",
	"| history | stable |\n\n",
	"Unicode stays intact: 東京, café, 🚀. ",
	"The volatile tail keeps growing while completed Markdown remains exact. ",
	"Each update is an authoritative snapshot of the assistant message. ",
	"Semantic boundaries still flush immediately, and the final render matches one-shot output.",
] as const;

class BenchmarkTerminal implements Terminal {
	readonly columns = WIDTH;
	readonly rows = HEIGHT;
	readonly kittyProtocolActive = false;
	readonly focusState = "unknown" as const;
	onFocusChange?: (focused: boolean) => void;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	alert(): void {}
	notify(_title: string, _body: string): void {}
}

class StaticHistory implements Component {
	private readonly lines: string[];

	constructor(lineCount: number) {
		this.lines = Array.from({ length: lineCount }, (_, index) => `history ${String(index).padStart(5, "0")}`);
	}

	render(_width: number): RenderFrame {
		return createRenderFrame(this.lines);
	}

	invalidate(): void {}
}

class VirtualScheduler implements StreamingRenderScheduler {
	private now = 0;
	private nextId = 1;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	advanceBy(delayMs: number): void {
		const target = this.now + delayMs;
		while (true) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			const [id, task] = due;
			this.tasks.delete(id);
			this.now = task.at;
			task.callback();
		}
		this.now = target;
	}
}

function createMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "benchmark",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function createSnapshots(): AssistantMessage[] {
	let text = "";
	return STREAM_PARTS.map((part) => {
		text += part;
		return createMessage(text);
	});
}

async function waitForFrame(tui: TUI, previousFrames: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (tui.getRenderMetrics().frames <= previousFrames) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for benchmark frame");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function createHarness(historyLines: number): Promise<{
	tui: TUI;
	component: AssistantMessageComponent;
}> {
	const tui = new TuiMainScreen(new BenchmarkTerminal());
	const root = new Container();
	const component = new AssistantMessageComponent();
	root.addChild(new StaticHistory(historyLines));
	root.addChild(component);
	tui.addChild(root);
	tui.start();
	await waitForFrame(tui, 0);
	tui.resetRenderMetrics();
	return { tui, component };
}

async function runEager(historyLines: number, snapshots: AssistantMessage[]) {
	const { tui, component } = await createHarness(historyLines);
	try {
		for (const snapshot of snapshots) {
			const previousFrames = tui.getRenderMetrics().frames;
			component.updateContent(snapshot);
			tui.requestRender();
			await waitForFrame(tui, previousFrames);
		}
		return { metrics: tui.getRenderMetrics(), output: component.render(WIDTH) };
	} finally {
		tui.stop();
	}
}

async function runCoalesced(historyLines: number, snapshots: AssistantMessage[]) {
	const { tui, component } = await createHarness(historyLines);
	const scheduler = new VirtualScheduler();
	let commits = 0;
	const coalescer = new StreamingRenderCoalescer(
		(snapshot: AssistantMessage) => {
			component.updateContent(snapshot);
			commits++;
			tui.requestRender();
		},
		80,
		scheduler,
	);
	try {
		for (const snapshot of snapshots) {
			const previousCommits = commits;
			const previousFrames = tui.getRenderMetrics().frames;
			coalescer.update(snapshot);
			scheduler.advanceBy(CHUNK_INTERVAL_MS);
			if (commits > previousCommits) await waitForFrame(tui, previousFrames);
		}
		const previousFrames = tui.getRenderMetrics().frames;
		coalescer.finish(snapshots[snapshots.length - 1]);
		await waitForFrame(tui, previousFrames);
		return { metrics: tui.getRenderMetrics(), output: component.render(WIDTH) };
	} finally {
		coalescer.dispose();
		tui.stop();
	}
}

initTheme("dark");
const snapshots = createSnapshots();
const results = [];
for (const historyLines of HISTORY_LINE_COUNTS) {
	const eager = await runEager(historyLines, snapshots);
	const coalesced = await runCoalesced(historyLines, snapshots);
	if (eager.output.join("\n") !== coalesced.output.join("\n")) {
		throw new Error(`Final output mismatch with ${historyLines} history lines`);
	}
	const generatedLineRatio = coalesced.metrics.generatedLines / eager.metrics.generatedLines;
	if (generatedLineRatio > 0.35) {
		throw new Error(`Generated-line ratio ${generatedLineRatio.toFixed(3)} exceeded 0.35`);
	}
	if (coalesced.metrics.frames >= eager.metrics.frames) {
		throw new Error(`Coalescing did not reduce frames with ${historyLines} history lines`);
	}
	if (coalesced.metrics.terminalWrites >= eager.metrics.terminalWrites) {
		throw new Error(`Coalescing did not reduce terminal writes with ${historyLines} history lines`);
	}
	if (historyLines > 0 && coalesced.metrics.fullRedraws !== 0) {
		throw new Error(`Coalescing triggered a full redraw with ${historyLines} history lines`);
	}
	results.push({
		historyLines,
		eager: eager.metrics,
		coalesced: coalesced.metrics,
		generatedLineRatio: Number(generatedLineRatio.toFixed(3)),
	});
}

console.log(JSON.stringify({ width: WIDTH, chunks: snapshots.length, results }, null, 2));
