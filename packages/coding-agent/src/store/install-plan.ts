import { VERSION } from "../config.ts";
import type { StorePackageInspection } from "./inspector.ts";
import type { StoreResolvedSource } from "./resolver.ts";

export type StoreInstallScope = "user" | "project";
export type StoreInstallScriptPolicy = "never" | "ask" | "allow";
export type StoreCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export interface StoreInstallPlan {
	input: string;
	source: string;
	scope: StoreInstallScope;
	tracking: boolean;
	resolved: StoreResolvedSource;
	inspection: StorePackageInspection;
	compatibility: StoreCompatibilityStatus;
	scriptPolicy: StoreInstallScriptPolicy;
	warnings: string[];
}

export interface BuildStoreInstallPlanOptions {
	resolved: StoreResolvedSource;
	inspection: StorePackageInspection;
	scope: StoreInstallScope;
	scriptPolicy: StoreInstallScriptPolicy;
	currentVersion?: string;
}

function parseVersionParts(version: string): [number, number, number] | undefined {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number | undefined {
	const leftParts = parseVersionParts(left);
	const rightParts = parseVersionParts(right);
	if (!leftParts || !rightParts) {
		return undefined;
	}
	for (let index = 0; index < leftParts.length; index++) {
		const diff = leftParts[index] - rightParts[index];
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

export function getCompatibilityStatus(range: string | undefined, currentVersion = VERSION): StoreCompatibilityStatus {
	if (!range) {
		return "unknown";
	}
	const trimmed = range.trim();
	if (!trimmed) {
		return "unknown";
	}

	const greaterThanOrEqual = trimmed.match(/^>=\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
	if (greaterThanOrEqual?.[1]) {
		const comparison = compareVersions(currentVersion, greaterThanOrEqual[1]);
		return comparison === undefined ? "unknown" : comparison >= 0 ? "compatible" : "incompatible";
	}

	const exact = trimmed.match(/^=?\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
	if (exact?.[1]) {
		const comparison = compareVersions(currentVersion, exact[1]);
		return comparison === undefined ? "unknown" : comparison === 0 ? "compatible" : "incompatible";
	}

	return "unknown";
}

function hasDirectScripts(inspection: StorePackageInspection): boolean {
	return Object.keys(inspection.scripts).length > 0;
}

export function buildStoreInstallPlan(options: BuildStoreInstallPlanOptions): StoreInstallPlan {
	const compatibility = getCompatibilityStatus(
		options.resolved.catalogPackage?.compatibility?.volt,
		options.currentVersion ?? VERSION,
	);
	const warnings = [
		...options.resolved.warnings,
		...options.inspection.warnings,
		"Extensions run as local code with the full permissions of the Volt process.",
	];

	if (options.resolved.catalogPackage && options.resolved.catalogPackage.verified !== true) {
		warnings.push("This catalog entry is not marked verified by Volt maintainers.");
	}
	if (compatibility === "incompatible") {
		warnings.push(`Catalog compatibility range is ${options.resolved.catalogPackage?.compatibility?.volt}.`);
	}
	if (options.scriptPolicy === "never") {
		warnings.push("Package lifecycle scripts will be disabled for this store install.");
	} else if (options.scriptPolicy === "allow") {
		warnings.push("Package lifecycle scripts are allowed for this store install.");
	} else if (hasDirectScripts(options.inspection)) {
		warnings.push(
			"Package declares scripts; interactive confirmation is required before allowing lifecycle scripts.",
		);
	}

	return {
		input: options.resolved.input,
		source: options.resolved.source,
		scope: options.scope,
		tracking: options.resolved.tracking,
		resolved: options.resolved,
		inspection: options.inspection,
		compatibility,
		scriptPolicy: options.scriptPolicy,
		warnings,
	};
}
