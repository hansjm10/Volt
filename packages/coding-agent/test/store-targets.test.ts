import { describe, expect, it } from "vitest";
import type { ConfiguredPackage } from "../src/core/package-manager.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	getMatchingStorePackageScopes,
	type StoreTargetPackageManager,
} from "../src/store/targets.ts";

function createManager(packages: ConfiguredPackage[]): StoreTargetPackageManager {
	return {
		getPackageIdentity(source) {
			return source;
		},
		listConfiguredPackages() {
			return packages;
		},
	};
}

describe("store target selection", () => {
	it("finds matching configured package scopes", () => {
		const manager = createManager([
			{ source: "npm:one@1.0.0", scope: "user", filtered: false },
			{ source: "npm:two@1.0.0", scope: "project", filtered: false },
		]);

		expect(getMatchingStorePackageScopes(manager, "npm:two@1.0.0")).toEqual([
			{ source: "npm:two@1.0.0", scope: "project" },
		]);
	});

	it("selects project scope for local remove", () => {
		const manager = createManager([
			{ source: "npm:pkg@1.0.0", scope: "user", filtered: false },
			{ source: "npm:pkg@1.0.0", scope: "project", filtered: false },
		]);

		expect(chooseStoreRemoveTarget(manager, "npm:pkg@1.0.0", true)).toEqual({
			target: { source: "npm:pkg@1.0.0", scope: "project" },
		});
	});

	it("reports ambiguous user/project targets", () => {
		const manager = createManager([
			{ source: "npm:pkg@1.0.0", scope: "user", filtered: false },
			{ source: "npm:pkg@1.0.0", scope: "project", filtered: false },
		]);

		expect(chooseStoreRemoveTarget(manager, "npm:pkg@1.0.0", false)).toEqual({ conflict: "both-scopes" });
		expect(chooseStoreUpdateTarget(manager, "npm:pkg@1.0.0")).toEqual({ conflict: "both-scopes" });
	});
});
