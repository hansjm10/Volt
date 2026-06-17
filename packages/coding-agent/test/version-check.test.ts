import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewVoltVersion,
	comparePackageVersions,
	getLatestVoltRelease,
	getLatestVoltVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.VOLT_SKIP_VERSION_CHECK;
const originalOffline = process.env.VOLT_OFFLINE;
const originalLatestVersionUrl = process.env.VOLT_LATEST_VERSION_URL;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.VOLT_SKIP_VERSION_CHECK;
	} else {
		process.env.VOLT_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.VOLT_OFFLINE;
	} else {
		process.env.VOLT_OFFLINE = originalOffline;
	}
	if (originalLatestVersionUrl === undefined) {
		delete process.env.VOLT_LATEST_VERSION_URL;
	} else {
		process.env.VOLT_LATEST_VERSION_URL = originalLatestVersionUrl;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewVoltVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewVoltVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("skips api calls when no version check endpoint is configured", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVoltVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the configured version check api with a volt user agent", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVoltVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://updates.example/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^volt\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/volt",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVoltRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/volt",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVoltRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.VOLT_LATEST_VERSION_URL = "https://updates.example/latest-version";
		process.env.VOLT_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVoltVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
