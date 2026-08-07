import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function persistedMessageRoles(harness: Harness): string[] {
	return harness.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
}

describe("regression #214: reentrant session disposal", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("fails fast when participant code joins disposal after an async hop, then permits an external join", async () => {
		let harness!: Harness;
		let capturedReceipt: Promise<void> | undefined;
		const participantErrors: string[] = [];
		let finallyCalls = 0;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						await Promise.resolve();
						const receipt = harness.session.dispose("disposal");
						capturedReceipt = receipt;
						try {
							await receipt;
						} catch (error) {
							participantErrors.push(errorMessage(error));
						}
						await receipt.catch((error) => {
							participantErrors.push(errorMessage(error));
						});
						await receipt
							.finally(() => {
								finallyCalls++;
							})
							.catch((error) => {
								participantErrors.push(errorMessage(error));
							});
						return { outcome: "committed" };
					},
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await harness.session.prompt("dispose after an async participant hop");
		const receipt = capturedReceipt;
		if (!receipt) throw new Error("Participant did not capture the disposal receipt");
		await receipt;

		expect(participantErrors).toHaveLength(3);
		for (const message of participantErrors) {
			expect(message).toContain('context.requestAbort("disposal")');
			expect(message).toContain("return the participant outcome");
			expect(message).toContain("await disposal after the Agent run settles");
		}
		expect(finallyCalls).toBe(1);
	});

	it("allows ignored reentrant disposal while preserving committed-message-before-abort ordering", async () => {
		let harness!: Harness;
		harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: () => {
						void harness.session.dispose("disposal");
						return { outcome: "committed" };
					},
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await harness.session.prompt("commit before ignored disposal", {
			clientMessageId: "issue-214-ignored-disposal",
		});
		await harness.session.dispose();

		expect(persistedMessageRoles(harness)).toEqual(["user", "assistant"]);
		expect(harness.sessionManager.buildSessionContext().messages[0]).toMatchObject({
			role: "user",
			clientMessageId: "issue-214-ignored-disposal",
		});
		expect(harness.sessionManager.buildSessionContext().messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "disposal" } })],
		});
	});

	it("keeps external disposal pending until active participant settlement completes", async () => {
		const settlementStarted = deferred();
		const releaseSettlement = deferred();
		const harness = await createHarness({
			prepareDelivery: (delivery) => ({
				messages: [...delivery.messages],
				participant: {
					settle: async () => {
						settlementStarted.resolve();
						await releaseSettlement.promise;
						return { outcome: "committed" };
					},
				},
			}),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		const prompt = harness.session.prompt("external disposal waits for settlement");
		await settlementStarted.promise;
		let disposalSettled = false;
		const disposal = harness.session.dispose("disposal").then(() => {
			disposalSettled = true;
		});
		await Promise.resolve();

		expect(disposalSettled).toBe(false);
		expect(persistedMessageRoles(harness)).toEqual([]);

		releaseSettlement.resolve();
		await Promise.all([prompt, disposal]);

		expect(disposalSettled).toBe(true);
		expect(persistedMessageRoles(harness)).toEqual(["user", "assistant"]);
	});
});
