import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-rpc-client-exit-"));
	tempDirs.push(dir);
	return dir;
}

function writeChildScript(contents: string): string {
	const dir = createTempDir();
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects start when the child process exits before readiness", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stderr.write("startup exploded");
setTimeout(() => {
	process.exit(42);
}, 10);
process.stdin.resume();
`),
			requestTimeoutMs: 1000,
		});

		await expect(client.start()).rejects.toThrow(
			/RPC readiness probe failed: Agent process exited \(code=42 signal=null\).*startup exploded/s,
		);
	});

	test("cleans up the child process when readiness probe fails", async () => {
		const dir = createTempDir();
		const childPath = join(dir, "child.mjs");
		const terminationMarker = join(dir, "terminated");
		writeFileSync(
			childPath,
			`
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
	writeFileSync(${JSON.stringify(terminationMarker)}, "terminated");
	process.exit(0);
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (!line) {
			continue;
		}
		const command = JSON.parse(line);
		if (command.type === "get_state") {
			process.stdout.write(JSON.stringify({
				id: command.id,
				type: "response",
				command: "get_state",
				success: false,
				error: "boot failed",
			}) + "\\n");
		}
	}
});
process.stdin.resume();
`,
		);
		const client = new RpcClient({ cliPath: childPath, requestTimeoutMs: 1000 });

		await expect(client.start()).rejects.toThrow(/RPC readiness probe failed: boot failed/);
		expect(existsSync(terminationMarker)).toBe(true);
	});

	test("cleans up the child process when readiness probe times out", async () => {
		const dir = createTempDir();
		const childPath = join(dir, "child.mjs");
		const terminationMarker = join(dir, "terminated");
		writeFileSync(
			childPath,
			`
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
	writeFileSync(${JSON.stringify(terminationMarker)}, "terminated");
	process.exit(0);
});

process.stdin.resume();
`,
		);
		const client = new RpcClient({ cliPath: childPath, requestTimeoutMs: 50 });

		await expect(client.start()).rejects.toThrow(
			/RPC readiness probe failed: Timeout waiting for response to get_state/,
		);
		expect(existsSync(terminationMarker)).toBe(true);
	});

	test("allows startup extension UI events to be handled before start resolves", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
let buffer = "";
let pendingGetStateId;

function writeJson(value) {
	process.stdout.write(JSON.stringify(value) + "\\n");
}

function handleCommand(command) {
	if (command.type === "get_state") {
		pendingGetStateId = command.id;
		writeJson({
			type: "extension_ui_request",
			id: "startup",
			method: "confirm",
			title: "Continue?",
			message: "Ready?",
		});
		return;
	}
	if (command.type === "extension_ui_response" && command.id === "startup") {
		writeJson({
			id: pendingGetStateId,
			type: "response",
			command: "get_state",
			success: true,
			data: {},
		});
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line) {
			handleCommand(JSON.parse(line));
		}
	}
});
process.stdin.resume();
`),
			requestTimeoutMs: 1000,
		});
		const events: Array<{ type: string; id?: string }> = [];
		client.onEvent((event) => {
			events.push(event);
			if (event.type === "extension_ui_request" && event.id === "startup") {
				void client.sendExtensionUIResponse({ type: "extension_ui_response", id: event.id, confirmed: true });
			}
		});

		try {
			await client.start();
			expect(events).toContainEqual(
				expect.objectContaining({ type: "extension_ui_request", id: "startup", method: "confirm" }),
			);
		} finally {
			await client.stop();
		}
	});

	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
let buffer = "";

function writeJson(value) {
	process.stdout.write(JSON.stringify(value) + "\\n");
}

function handleCommand(command) {
	if (command.type === "get_state") {
		writeJson({
			id: command.id,
			type: "response",
			command: "get_state",
			success: true,
			data: {},
		});
		return;
	}
	process.exit(43);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line) {
			handleCommand(JSON.parse(line));
		}
	}
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});
