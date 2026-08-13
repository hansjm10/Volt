/**
 * Tests that an invalidated ExtensionRunner is fully inert: no emit path runs
 * handlers, replacement hooks report no replacement, pass-through transforms
 * retain their input, and errors never reach listeners.
 *
 * Background: after session replacement (dispose) or reload, a dead runner
 * generation could still execute extension handlers whose stale ctx throws;
 * the resulting error leaked to live listeners (e.g. the RPC extension_error
 * stream to a remote client).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionError } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestExtensionsResult } from "./utilities.ts";

describe("ExtensionRunner stale-generation inertness", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "volt-runner-stale-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRunner() {
		const handlerCalls: string[] = [];
		const errors: ExtensionError[] = [];

		const extensionsResult = await createTestExtensionsResult(
			[
				(volt) => {
					volt.on("before_provider_request", (event, ctx) => {
						handlerCalls.push("before_provider_request");
						// Touch the ctx like real extensions do; throws when stale.
						void ctx.model;
						return { ...(event.payload as Record<string, unknown>), tagged: true };
					});
					volt.on("agent_start", () => {
						handlerCalls.push("agent_start");
					});
					volt.on("context", (event, ctx) => {
						handlerCalls.push("context");
						void ctx.model;
						return { messages: event.messages };
					});
					volt.on("input", () => {
						handlerCalls.push("input");
					});
				},
			],
			tempDir,
		);

		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir,
			SessionManager.inMemory(),
			ModelRegistry.create(AuthStorage.inMemory(), tempDir),
		);
		runner.onError((error) => {
			errors.push(error);
		});

		return { runner, runtime: extensionsResult.runtime, handlerCalls, errors };
	}

	it("runs handlers and reports errors while live (control)", async () => {
		const { runner, handlerCalls, errors } = await createRunner();

		const payload = { value: 1 };
		const result = await runner.emitBeforeProviderRequest(payload);

		expect(handlerCalls).toEqual(["before_provider_request"]);
		expect(result).toEqual({ value: 1, tagged: true });
		expect(errors).toEqual([]);
		expect(runner.hasHandlers("before_provider_request")).toBe(true);

		runner.emitError({ extensionPath: "x", event: "test", error: "boom" });
		expect(errors).toHaveLength(1);
	});

	it("does not run handlers or mutate payloads after invalidate()", async () => {
		const { runner, handlerCalls, errors } = await createRunner();

		runner.invalidate();

		const payload = { value: 1 };
		const result = await runner.emitBeforeProviderRequest(payload);
		expect(result).toBeUndefined();

		const messages = [{ role: "user" as const, content: "hi", timestamp: Date.now() }];
		const contextResult = await runner.emitContext(messages);
		expect(contextResult).toBe(messages);

		const emitResult = await runner.emit({ type: "agent_start" });
		expect(emitResult).toBeUndefined();

		const toolCallResult = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "echo hi" },
		});
		expect(toolCallResult).toBeUndefined();

		const inputResult = await runner.emitInput("hello", undefined, "interactive");
		expect(inputResult).toEqual({ action: "continue" });

		expect(handlerCalls).toEqual([]);
		expect(runner.hasHandlers("before_provider_request")).toBe(false);
		expect(errors).toEqual([]);
	});

	it("does not notify error listeners after invalidate()", async () => {
		const { runner, errors } = await createRunner();

		runner.invalidate();
		runner.emitError({ extensionPath: "x", event: "test", error: "boom" });

		expect(errors).toEqual([]);
	});

	it("invalidateStaleGeneration is a no-op when the runtime is shared", async () => {
		const { runner, runtime, handlerCalls } = await createRunner();

		// Same runtime object: the runner is still the live generation.
		runner.invalidateStaleGeneration(runtime);

		await runner.emitBeforeProviderRequest({ value: 1 });
		expect(handlerCalls).toEqual(["before_provider_request"]);
	});

	it("invalidateStaleGeneration invalidates when a new runtime replaced this generation", async () => {
		const { runner, handlerCalls } = await createRunner();

		runner.invalidateStaleGeneration(createExtensionRuntime());

		const payload = { value: 1 };
		const result = await runner.emitBeforeProviderRequest(payload);
		expect(result).toBeUndefined();
		expect(handlerCalls).toEqual([]);
		expect(() => runner.createContext().cwd).toThrow(/stale after session replacement or reload/);
	});
});
