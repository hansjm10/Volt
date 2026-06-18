import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/volt-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/volt-coding-agent";
import type { TSchema } from "typebox";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_WORKFLOWS = "simulator,ui-automation,debugging";

type JsonRecord = Record<string, unknown>;
type VoltContent = TextContent | ImageContent;

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: number;
	result: unknown;
}

interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: number;
	error: {
		code?: number;
		message: string;
		data?: unknown;
	};
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: JsonRecord;
	annotations?: {
		title?: string;
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		openWorldHint?: boolean;
	};
}

interface ToolsListResult {
	tools: McpTool[];
	nextCursor?: string;
}

interface McpTextContent {
	type: "text";
	text: string;
}

interface McpImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

type McpContent = McpTextContent | McpImageContent | JsonRecord;

interface McpCallToolResult {
	content?: McpContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

interface XcodeBuildMcpPackageJson {
	bin?: {
		xcodebuildmcp?: string;
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	if (
		!isRecord(value) ||
		value.jsonrpc !== "2.0" ||
		typeof value.id !== "number"
	)
		return false;
	return (
		"result" in value ||
		(isRecord(value.error) && typeof value.error.message === "string")
	);
}

function asToolsListResult(value: unknown): ToolsListResult {
	if (!isRecord(value) || !Array.isArray(value.tools)) {
		throw new Error("XcodeBuildMCP returned an invalid tools/list response");
	}
	const tools = value.tools.filter(
		(tool): tool is McpTool => isRecord(tool) && typeof tool.name === "string",
	);
	return {
		tools,
		nextCursor:
			typeof value.nextCursor === "string" ? value.nextCursor : undefined,
	};
}

function asCallToolResult(value: unknown): McpCallToolResult {
	if (!isRecord(value)) {
		return { content: [{ type: "text", text: JSON.stringify(value) }] };
	}
	return {
		content: Array.isArray(value.content)
			? (value.content as McpContent[])
			: undefined,
		isError: value.isError === true,
		structuredContent: value.structuredContent,
	};
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, "\t");
	} catch {
		return String(value);
	}
}

function normalizeSchema(schema: JsonRecord | undefined): TSchema {
	const fallback = {
		type: "object",
		properties: {},
		additionalProperties: true,
	};
	return (schema ?? fallback) as unknown as TSchema;
}

function formatMcpContent(content: McpContent[] | undefined): VoltContent[] {
	if (!content || content.length === 0) {
		return [{ type: "text", text: "" }];
	}

	return content.map((part): VoltContent => {
		if (
			isRecord(part) &&
			part.type === "text" &&
			typeof part.text === "string"
		) {
			return { type: "text", text: part.text };
		}
		if (
			isRecord(part) &&
			part.type === "image" &&
			typeof part.data === "string" &&
			typeof part.mimeType === "string"
		) {
			return { type: "image", data: part.data, mimeType: part.mimeType };
		}
		return { type: "text", text: stringifyUnknown(part) };
	});
}

function textFromContent(content: VoltContent[]): string {
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || "XcodeBuildMCP tool failed";
}

function getXcodeBuildMcpCliPath(): string {
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("xcodebuildmcp/package.json");
	const parsed = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as XcodeBuildMcpPackageJson;
	const binPath = parsed.bin?.xcodebuildmcp;
	if (!binPath) {
		throw new Error(
			"xcodebuildmcp package does not expose an xcodebuildmcp binary",
		);
	}
	return resolve(dirname(packageJsonPath), binPath);
}

class XcodeBuildMcpClient {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private cwd: string | undefined;
	private nextId = 1;
	private stdoutBuffer = "";
	private stderrTail = "";
	private pending = new Map<number, PendingRequest>();
	private startPromise: Promise<void> | undefined;

	async ensureStarted(cwd: string): Promise<void> {
		if (this.proc && this.cwd === cwd) return;
		if (this.startPromise) {
			await this.startPromise;
			if (this.proc && this.cwd === cwd) return;
		}
		this.stop();
		this.startPromise = this.start(cwd).finally(() => {
			this.startPromise = undefined;
		});
		await this.startPromise;
	}

	async listTools(cwd: string): Promise<McpTool[]> {
		await this.ensureStarted(cwd);
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const params: JsonRecord = cursor ? { cursor } : {};
			const result = asToolsListResult(
				await this.request("tools/list", params, STARTUP_TIMEOUT_MS),
			);
			tools.push(...result.tools);
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(
		cwd: string,
		name: string,
		args: JsonRecord,
		signal: AbortSignal | undefined,
	): Promise<McpCallToolResult> {
		await this.ensureStarted(cwd);
		const request = this.request("tools/call", { name, arguments: args });
		if (!signal) {
			return asCallToolResult(await request);
		}
		if (signal.aborted) {
			this.stop();
			throw new Error("Operation aborted");
		}

		return asCallToolResult(
			await new Promise<unknown>((resolveValue, reject) => {
				const abort = (): void => {
					this.stop();
					reject(new Error("Operation aborted"));
				};
				signal.addEventListener("abort", abort, { once: true });
				request.then(resolveValue, reject).finally(() => {
					signal.removeEventListener("abort", abort);
				});
			}),
		);
	}

	stop(): void {
		const proc = this.proc;
		this.proc = undefined;
		this.cwd = undefined;
		this.stdoutBuffer = "";
		if (proc && proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGKILL");
				}
			}, 1_000).unref();
		}
		this.rejectPending(new Error("XcodeBuildMCP server stopped"));
	}

	private async start(cwd: string): Promise<void> {
		const cliPath = getXcodeBuildMcpCliPath();
		this.stderrTail = "";
		const env = {
			...process.env,
			XCODEBUILDMCP_ENABLED_WORKFLOWS:
				process.env.VOLT_XCODEBUILDMCP_WORKFLOWS ??
				process.env.XCODEBUILDMCP_ENABLED_WORKFLOWS ??
				DEFAULT_WORKFLOWS,
		};

		this.cwd = cwd;
		this.proc = spawn(process.execPath, [cliPath, "mcp"], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk: string) => {
			this.handleStdout(chunk);
		});
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
		});
		this.proc.on("error", (error) => {
			this.rejectPending(error);
		});
		this.proc.on("exit", (code, signal) => {
			this.proc = undefined;
			const stderr = this.stderrTail.trim();
			const suffix = stderr ? `\n${stderr}` : "";
			this.rejectPending(
				new Error(
					`XcodeBuildMCP server exited (${signal ?? code ?? "unknown"}).${suffix}`,
				),
			);
		});

		try {
			await this.request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: {
						name: "volt-build-ios-apps",
						version: "0.1.2",
					},
				},
				STARTUP_TIMEOUT_MS,
			);
			this.notify("notifications/initialized", {});
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	private request(
		method: string,
		params: JsonRecord,
		timeoutMs?: number,
	): Promise<unknown> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
			return Promise.reject(new Error("XcodeBuildMCP server is not running"));
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolveValue, reject) => {
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`${method} timed out after ${timeoutMs}ms`));
						}, timeoutMs);
			timer?.unref();
			this.pending.set(id, { resolve: resolveValue, reject, timer });
			proc.stdin.write(`${payload}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				reject(error);
			});
		});
	}

	private notify(method: string, params: JsonRecord): void {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		const lines = this.stdoutBuffer.split("\n");
		this.stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!isJsonRpcResponse(parsed)) continue;
			const pending = this.pending.get(parsed.id);
			if (!pending) continue;
			this.pending.delete(parsed.id);
			if (pending.timer) clearTimeout(pending.timer);
			if ("error" in parsed) {
				pending.reject(new Error(parsed.error.message));
			} else {
				pending.resolve(parsed.result);
			}
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function createToolDefinition(
	client: XcodeBuildMcpClient,
	tool: McpTool,
): ToolDefinition<TSchema, JsonRecord> {
	const label = tool.annotations?.title ?? tool.name;
	return {
		name: tool.name,
		label,
		description: tool.description ?? `Forward ${tool.name} to XcodeBuildMCP.`,
		promptSnippet:
			tool.description ?? `Run the XcodeBuildMCP ${tool.name} tool.`,
		parameters: normalizeSchema(tool.inputSchema),
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<JsonRecord>> {
			const args = isRecord(params) ? params : {};
			const result = await client.callTool(ctx.cwd, tool.name, args, signal);
			const content = formatMcpContent(result.content);
			if (result.isError) {
				throw new Error(textFromContent(content));
			}
			return {
				content,
				details: {
					tool: tool.name,
					...(result.structuredContent !== undefined
						? { structuredContent: result.structuredContent }
						: {}),
				},
			};
		},
	};
}

export default function xcodeBuildMcpExtension(volt: ExtensionAPI): void {
	const client = new XcodeBuildMcpClient();
	const registered = new Set<string>();

	volt.on("session_start", async (_event, ctx) => {
		try {
			const tools = await client.listTools(ctx.cwd);
			for (const tool of tools) {
				if (registered.has(tool.name)) continue;
				registered.add(tool.name);
				volt.registerTool(createToolDefinition(client, tool));
			}
			ctx.ui.notify(
				`XcodeBuildMCP registered ${tools.length} native Volt tools.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`XcodeBuildMCP tools unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	volt.on("session_shutdown", () => {
		client.stop();
	});
}
