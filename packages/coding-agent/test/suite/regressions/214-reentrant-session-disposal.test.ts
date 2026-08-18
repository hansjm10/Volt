import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function persistedMessageRoles(harness: Harness): string[] {
	return harness.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
}

describe("regression #214: reentrant session disposal", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			harness.session.dispose();
			await harness.session.waitForClosed();
			harness.cleanup();
		}
	});

	it("installs a synchronous fence and exposes a stable external close join", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.dispose()).toBeUndefined();
		const closed = harness.session.waitForClosed();
		harness.session.dispose();
		expect(harness.session.waitForClosed()).toBe(closed);
		await closed;
		await expect(harness.session.prompt("too late")).rejects.toThrow("disposed");
	});

	it("allows a provider callback to request close without joining its own run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let closed: Promise<void> | undefined;
		harness.setResponses([
			() => {
				harness.session.dispose("disposal");
				closed = harness.session.waitForClosed();
				return fauxAssistantMessage("must remain unused");
			},
		]);

		await harness.session.prompt("commit before callback disposal", {
			clientMessageId: "issue-214-fence-only-disposal",
		});
		if (!closed) throw new Error("Provider callback did not request close");
		await closed;

		expect(persistedMessageRoles(harness)).toEqual(["user", "assistant"]);
		expect(harness.sessionManager.buildSessionContext().messages[0]).toMatchObject({
			role: "user",
			clientMessageId: "issue-214-fence-only-disposal",
		});
	});

	it("keeps the external close join pending until an active provider request settles", async () => {
		const responseStarted = deferred();
		const releaseResponse = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				responseStarted.resolve();
				await releaseResponse.promise;
				return fauxAssistantMessage("late response");
			},
		]);

		const prompt = harness.session.prompt("external disposal waits for provider settlement");
		await responseStarted.promise;
		harness.session.dispose("disposal");
		let disposalSettled = false;
		const closed = harness.session.waitForClosed().then(() => {
			disposalSettled = true;
		});
		await Promise.resolve();

		expect(disposalSettled).toBe(false);
		expect(persistedMessageRoles(harness)).toEqual(["user"]);

		releaseResponse.resolve();
		await Promise.all([prompt, closed]);
		expect(disposalSettled).toBe(true);
		expect(persistedMessageRoles(harness)).toEqual(["user", "assistant"]);
	});

	it("keeps the external close join pending until abort-ignoring bash work settles", async () => {
		const bashStarted = deferred();
		const releaseBash = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async () => {
				bashStarted.resolve();
				await releaseBash.promise;
				return { exitCode: 0 };
			},
		};

		const bash = harness.session.executeBash("ignored abort", undefined, { operations }).catch(() => undefined);
		await bashStarted.promise;
		harness.session.dispose();
		let closed = false;
		const close = harness.session.waitForClosed().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);

		releaseBash.resolve();
		await Promise.all([bash, close]);
		expect(closed).toBe(true);
	});
});
