import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenSessionStoreSidecars } from "../../src/core/session-store/artifacts.ts";

const roots: string[] = [];
function paths(): { database: string; target: string } {
	const root = mkdtempSync(join(tmpdir(), "volt-sidecar-"));
	roots.push(root);
	return { database: join(root, "sessions.sqlite"), target: join(root, "target") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Regression #341 session sidecar hardening", () => {
	it("allows absent and removed sidecars while hardening existing regular files", () => {
		const { database } = paths();
		expect(() => hardenSessionStoreSidecars(database)).not.toThrow();
		writeFileSync(`${database}-wal`, "wal");
		writeFileSync(`${database}-shm`, "shm");
		chmodSync(`${database}-wal`, 0o644);
		hardenSessionStoreSidecars(database);
		if (process.platform !== "win32") {
			expect(statSync(`${database}-wal`).mode & 0o777).toBe(0o600);
			expect(statSync(`${database}-shm`).mode & 0o777).toBe(0o600);
		}
		expect(readFileSync(`${database}-wal`, "utf8")).toBe("wal");
		rmSync(`${database}-wal`);
		expect(() => hardenSessionStoreSidecars(database)).not.toThrow();
	});

	it.skipIf(process.platform === "win32")("rejects both live and dangling symlinks without touching targets", () => {
		const { database, target } = paths();
		writeFileSync(target, "private target", { mode: 0o644 });
		symlinkSync(target, `${database}-wal`);
		expect(() => hardenSessionStoreSidecars(database)).toThrow();
		expect(readFileSync(target, "utf8")).toBe("private target");
		expect(statSync(target).mode & 0o777).toBe(0o644);
		rmSync(target);
		expect(() => hardenSessionStoreSidecars(database)).toThrow();
	});

	it("rejects multiply-linked sidecars without changing their contents", () => {
		const { database, target } = paths();
		writeFileSync(target, "target");
		linkSync(target, `${database}-wal`);
		expect(() => hardenSessionStoreSidecars(database)).toThrow(/non-private/);
		expect(readFileSync(target, "utf8")).toBe("target");
	});
});
