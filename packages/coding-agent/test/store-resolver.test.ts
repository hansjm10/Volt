import { describe, expect, it } from "vitest";
import type { StoreCatalog } from "../src/store/catalog.ts";
import { resolveStoreSource } from "../src/store/resolver.ts";

const catalog: StoreCatalog = {
	schemaVersion: 1,
	packages: [
		{
			id: "rtk",
			name: "RTK",
			description: "Token optimized shell output",
			source: "git:github.com/earendil-works/volt-rtk@v0.1.0",
		},
		{
			id: "theme",
			name: "Theme",
			description: "Theme package",
			source: "npm:@scope/theme@1.0.0",
		},
	],
};

describe("store resolver", () => {
	it("maps catalog IDs to sources and preserves catalog metadata", async () => {
		const resolved = await resolveStoreSource({ input: "rtk", catalog });

		expect(resolved.kind).toBe("catalog");
		expect(resolved.source).toBe("git:github.com/earendil-works/volt-rtk@v0.1.0");
		expect(resolved.catalogPackage?.id).toBe("rtk");
		expect(resolved.pinned).toBe(true);
	});

	it("rejects unknown bare IDs with suggestions", async () => {
		await expect(resolveStoreSource({ input: "rkt", catalog })).rejects.toThrow("Did you mean rtk?");
	});

	it("recognizes exact and unpinned npm specs", async () => {
		const exact = await resolveStoreSource({ input: "npm:@scope/pkg@1.2.3", catalog });
		const unpinned = await resolveStoreSource({ input: "npm:@scope/pkg", catalog });

		expect(exact.pinned).toBe(true);
		expect(exact.tracking).toBe(false);
		expect(unpinned.pinned).toBe(false);
		expect(unpinned.tracking).toBe(true);
		expect(unpinned.warnings).toContain("npm package @scope/pkg is not pinned to an exact version.");
	});

	it("does not mark ranged npm catalog sources as tracking", async () => {
		const rangedCatalog: StoreCatalog = {
			schemaVersion: 1,
			packages: [
				...catalog.packages,
				{
					id: "ranged-theme",
					name: "Ranged Theme",
					description: "Theme package",
					source: "npm:@scope/ranged-theme@^1.0.0",
				},
				{
					id: "latest-theme",
					name: "Latest Theme",
					description: "Theme package",
					source: "npm:@scope/latest-theme@latest",
				},
			],
		};
		const ranged = await resolveStoreSource({ input: "ranged-theme", catalog: rangedCatalog });
		const latest = await resolveStoreSource({ input: "latest-theme", catalog: rangedCatalog });

		expect(ranged.pinned).toBe(true);
		expect(ranged.tracking).toBe(false);
		expect(ranged.warnings).toContain('npm package @scope/ranged-theme uses non-exact version spec "^1.0.0".');
		expect(latest.pinned).toBe(true);
		expect(latest.tracking).toBe(false);
		expect(latest.warnings).toContain('npm package @scope/latest-theme uses non-exact version spec "latest".');
	});

	it("pins ref-less git sources to remote HEAD by default", async () => {
		const resolved = await resolveStoreSource({
			input: "https://github.com/user/repo",
			catalog,
			gitLsRemote: async () => "0123456789abcdef0123456789abcdef01234567\tHEAD",
		});

		expect(resolved.source).toBe("git:https://github.com/user/repo@0123456789abcdef0123456789abcdef01234567");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tracking).toBe(false);
	});

	it("preserves SSH clone URLs and ports when pinning ref-less git sources", async () => {
		let lsRemoteRepo: string | undefined;
		const resolved = await resolveStoreSource({
			input: "git:ssh://git@example.com:2222/user/repo",
			catalog,
			gitLsRemote: async (repo) => {
				lsRemoteRepo = repo;
				return "0123456789abcdef0123456789abcdef01234567\tHEAD";
			},
		});

		expect(lsRemoteRepo).toBe("ssh://git@example.com:2222/user/repo");
		expect(resolved.source).toBe("git:ssh://git@example.com:2222/user/repo@0123456789abcdef0123456789abcdef01234567");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tracking).toBe(false);
	});

	it("preserves ref-less git sources with --track", async () => {
		const resolved = await resolveStoreSource({
			input: "https://github.com/user/repo",
			catalog,
			track: true,
		});

		expect(resolved.source).toBe("git:https://github.com/user/repo");
		expect(resolved.pinned).toBe(false);
		expect(resolved.tracking).toBe(true);
		expect(resolved.warnings).toContain(
			"Git source has no ref and will track the repository default branch if installed.",
		);
	});

	it("rejects --ref for npm sources", async () => {
		await expect(resolveStoreSource({ input: "npm:@scope/pkg@1.0.0", catalog, ref: "main" })).rejects.toThrow(
			"--ref is only valid for git store sources",
		);
	});
});
