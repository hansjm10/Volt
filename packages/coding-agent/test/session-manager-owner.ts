import { vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

export interface SessionManagerTestOwner {
	start(): void;
	drain(): Promise<void>;
}

export function createSessionManagerTestOwner(): SessionManagerTestOwner {
	const managers: SessionManager[] = [];
	let spies: Array<{ mockRestore(): void }> = [];
	const create = SessionManager.create.bind(SessionManager);
	const open = SessionManager.open.bind(SessionManager);
	const continueRecent = SessionManager.continueRecent.bind(SessionManager);
	const forkFrom = SessionManager.forkFrom.bind(SessionManager);
	const importFromJsonl = SessionManager.importFromJsonl.bind(SessionManager);
	const track = (manager: SessionManager): SessionManager => {
		managers.push(manager);
		return manager;
	};

	return {
		start(): void {
			if (spies.length > 0) throw new Error("SessionManager test ownership is already active");
			spies = [
				vi.spyOn(SessionManager, "create").mockImplementation(async (...args) => track(await create(...args))),
				vi.spyOn(SessionManager, "open").mockImplementation(async (...args) => track(await open(...args))),
				vi
					.spyOn(SessionManager, "continueRecent")
					.mockImplementation(async (...args) => track(await continueRecent(...args))),
				vi.spyOn(SessionManager, "forkFrom").mockImplementation(async (...args) => track(await forkFrom(...args))),
				vi
					.spyOn(SessionManager, "importFromJsonl")
					.mockImplementation(async (...args) => track(await importFromJsonl(...args))),
			];
		},
		async drain(): Promise<void> {
			const errors: unknown[] = [];
			while (managers.length > 0) {
				try {
					await managers.pop()!.drainPersistence();
				} catch (error) {
					errors.push(error);
				}
			}
			for (const spy of spies.splice(0).reverse()) spy.mockRestore();
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Persisted SessionManager test cleanup failed");
		},
	};
}
