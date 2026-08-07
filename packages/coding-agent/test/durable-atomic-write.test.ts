import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
	type DurableAtomicWriteOperations,
	type DurableAtomicWriteSyncOperations,
	type DurableFileSyncOperations,
	syncDurableFile,
	writeDurableAtomicFile,
	writeDurableAtomicFileSync,
} from "../src/utils/durable-atomic-write.ts";

function createOperations(events: string[]): DurableAtomicWriteOperations {
	return {
		mkdir: vi.fn(async () => {
			events.push("mkdir");
		}),
		open: vi.fn(async (_path, flags) => {
			const kind = flags === "r" ? "parent" : "temp";
			events.push(`open:${kind}`);
			return {
				writeFile: vi.fn(async (content: string | Uint8Array) => {
					events.push(
						typeof content === "string"
							? `write:${content}`
							: `write-binary:${Buffer.from(content).toString("hex")}`,
					);
				}),
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		}),
		rename: vi.fn(async () => {
			events.push("rename");
		}),
		rm: vi.fn(async () => {
			events.push("rm");
		}),
	};
}

function createFileSyncOperations(events: string[]): DurableFileSyncOperations {
	return {
		open: vi.fn(async (path, flags) => {
			const kind = path === "/state/host.json" ? "target" : "parent";
			events.push(`open:${kind}:${flags}`);
			return {
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		}),
	};
}

function createSyncOperations(events: string[]): DurableAtomicWriteSyncOperations {
	let nextFd = 1;
	const kinds = new Map<number, "parent" | "temp">();
	return {
		mkdir: vi.fn(() => {
			events.push("mkdir");
		}),
		open: vi.fn((_path, flags) => {
			const kind = flags === "r" ? "parent" : "temp";
			const fd = nextFd++;
			kinds.set(fd, kind);
			events.push(`open:${kind}`);
			return fd;
		}),
		writeFile: vi.fn((fd, content) => {
			events.push(`write:${kinds.get(fd)}:${content}`);
		}),
		fsync: vi.fn((fd) => {
			events.push(`sync:${kinds.get(fd)}`);
		}),
		close: vi.fn((fd) => {
			events.push(`close:${kinds.get(fd)}`);
		}),
		rename: vi.fn(() => {
			events.push("rename");
		}),
		rm: vi.fn(() => {
			events.push("rm");
		}),
	};
}

describe("durable atomic writes", () => {
	it("synchronizes the visible target before its parent directory", async () => {
		const events: string[] = [];
		await syncDurableFile("/state/host.json", { operations: createFileSyncOperations(events) });

		expect(events).toEqual([
			"open:target:r+",
			"sync:target",
			"close:target",
			...(process.platform === "win32" ? [] : ["open:parent:r", "sync:parent", "close:parent"]),
		]);
	});

	it("closes the visible target and stops when its synchronization fails", async () => {
		const events: string[] = [];
		const operations = createFileSyncOperations(events);
		operations.open = vi.fn(async (path, flags) => {
			const kind = path === "/state/host.json" ? "target" : "parent";
			events.push(`open:${kind}:${flags}`);
			return {
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
					throw new Error("injected target fsync failure");
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		});

		await expect(syncDurableFile("/state/host.json", { operations })).rejects.toThrow(
			"injected target fsync failure",
		);
		expect(events).toEqual(["open:target:r+", "sync:target", "close:target"]);
	});

	if (process.platform !== "win32") {
		it("closes the parent directory when its synchronization fails", async () => {
			const events: string[] = [];
			const operations = createFileSyncOperations(events);
			operations.open = vi.fn(async (path, flags) => {
				const kind = path === "/state/host.json" ? "target" : "parent";
				events.push(`open:${kind}:${flags}`);
				return {
					sync: vi.fn(async () => {
						events.push(`sync:${kind}`);
						if (kind === "parent") throw new Error("injected parent fsync failure");
					}),
					close: vi.fn(async () => {
						events.push(`close:${kind}`);
					}),
				};
			});

			await expect(syncDurableFile("/state/host.json", { operations })).rejects.toThrow(
				"injected parent fsync failure",
			);
			expect(events).toEqual([
				"open:target:r+",
				"sync:target",
				"close:target",
				"open:parent:r",
				"sync:parent",
				"close:parent",
			]);
		});
	}

	it("uses the supported durability ordering for asynchronous writes", async () => {
		const events: string[] = [];
		await writeDurableAtomicFile("/state/host.json", "payload", { operations: createOperations(events) });

		expect(events).toEqual([
			"mkdir",
			"open:temp",
			"write:payload",
			"sync:temp",
			"close:temp",
			"rename",
			...(process.platform === "win32" ? [] : ["open:parent", "sync:parent", "close:parent"]),
		]);
	});

	it("writes binary content without changing the asynchronous durability ordering", async () => {
		const events: string[] = [];
		await writeDurableAtomicFile("/images/generated.png", Uint8Array.from([0, 1, 2, 255]), {
			operations: createOperations(events),
		});

		expect(events).toEqual([
			"mkdir",
			"open:temp",
			"write-binary:000102ff",
			"sync:temp",
			"close:temp",
			"rename",
			...(process.platform === "win32" ? [] : ["open:parent", "sync:parent", "close:parent"]),
		]);
	});

	it("closes and removes an unrenamed temp file when fsync fails", async () => {
		const events: string[] = [];
		const operations = createOperations(events);
		operations.open = vi.fn(async (_path, flags) => {
			const kind = flags === "r" ? "parent" : "temp";
			events.push(`open:${kind}`);
			return {
				writeFile: vi.fn(async () => {
					events.push(`write:${kind}`);
				}),
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
					throw new Error("injected fsync failure");
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		});

		await expect(writeDurableAtomicFile("/state/host.json", "payload", { operations })).rejects.toThrow(
			"injected fsync failure",
		);
		expect(events).toEqual(["mkdir", "open:temp", "write:temp", "sync:temp", "close:temp", "rm"]);
		expect(operations.rename).not.toHaveBeenCalled();
	});

	it("uses the supported durability ordering for synchronous writes", () => {
		const events: string[] = [];
		writeDurableAtomicFileSync("/state/host.json", "payload", { operations: createSyncOperations(events) });

		expect(events).toEqual([
			"mkdir",
			"open:temp",
			"write:temp:payload",
			"sync:temp",
			"close:temp",
			"rename",
			...(process.platform === "win32" ? [] : ["open:parent", "sync:parent", "close:parent"]),
		]);
	});

	it("closes and removes a synchronous temp file when fsync fails", () => {
		const events: string[] = [];
		const operations = createSyncOperations(events);
		operations.fsync = vi.fn(() => {
			events.push("sync:temp");
			throw new Error("injected synchronous fsync failure");
		});

		expect(() => writeDurableAtomicFileSync("/state/host.json", "payload", { operations })).toThrow(
			"injected synchronous fsync failure",
		);
		expect(events).toEqual(["mkdir", "open:temp", "write:temp:payload", "sync:temp", "close:temp", "rm"]);
		expect(operations.rename).not.toHaveBeenCalled();
	});
});
