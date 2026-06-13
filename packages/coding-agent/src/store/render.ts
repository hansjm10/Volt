import chalk from "chalk";
import type { StoreCatalogPackage, StoreResourceType } from "./catalog.ts";
import type { StorePackageInspection, StoreVoltManifest } from "./inspector.ts";
import type { StoreInstallPlan } from "./install-plan.ts";
import type { StoreResolvedSource } from "./resolver.ts";

const RESOURCE_TYPES: StoreResourceType[] = ["extensions", "skills", "prompts", "themes"];

function formatList(values: readonly string[] | undefined): string {
	return values && values.length > 0 ? values.join(", ") : "none";
}

function renderRecord(title: string, values: Record<string, string>): string[] {
	const entries = Object.entries(values);
	if (entries.length === 0) {
		return [`${title}: none`];
	}
	return [`${title}:`, ...entries.map(([name, version]) => `  - ${name}: ${version}`)];
}

function renderVoltManifest(manifest: StoreVoltManifest | undefined): string[] {
	if (!manifest) {
		return ["Volt manifest: none"];
	}
	const lines = ["Volt manifest:"];
	for (const resourceType of RESOURCE_TYPES) {
		const entries = manifest[resourceType];
		if (entries !== undefined) {
			lines.push(`  ${resourceType}: ${formatList(entries)}`);
		}
	}
	if (manifest.image) {
		lines.push(`  image: ${manifest.image}`);
	}
	if (manifest.video) {
		lines.push(`  video: ${manifest.video}`);
	}
	return lines;
}

function renderDiscoveredResources(inspection: StorePackageInspection): string[] {
	const lines = ["Discovered resources:"];
	for (const resourceType of RESOURCE_TYPES) {
		lines.push(`  ${resourceType}: ${formatList(inspection.discoveredResources[resourceType])}`);
	}
	return lines;
}

function renderWarnings(warnings: readonly string[]): string[] {
	if (warnings.length === 0) {
		return [];
	}
	return ["Warnings:", ...warnings.map((warning) => `  - ${warning}`)];
}

export function renderCatalogSearch(packages: readonly StoreCatalogPackage[], query?: string): string {
	if (packages.length === 0) {
		return query?.trim() ? `No store packages found for "${query.trim()}".` : "No store packages found.";
	}

	const lines = [chalk.bold("Store packages:")];
	for (const pkg of packages) {
		const verified = pkg.verified ? " verified" : "";
		const categories = pkg.categories && pkg.categories.length > 0 ? ` [${pkg.categories.join(", ")}]` : "";
		lines.push(`${pkg.id} - ${pkg.name}${verified}${categories}`);
		lines.push(chalk.dim(`  ${pkg.description}`));
		lines.push(chalk.dim(`  ${pkg.source}`));
	}
	return lines.join("\n");
}

export function renderStoreShow(resolved: StoreResolvedSource, inspection: StorePackageInspection): string {
	const lines: string[] = [];
	const catalogPackage = resolved.catalogPackage;
	if (catalogPackage) {
		lines.push(chalk.bold(catalogPackage.name));
		lines.push(`ID: ${catalogPackage.id}`);
		lines.push(`Description: ${catalogPackage.description}`);
		lines.push(`Source: ${catalogPackage.source}`);
		lines.push(`Verified: ${catalogPackage.verified === true ? "yes" : "no"}`);
		if (catalogPackage.repo) lines.push(`Repo: ${catalogPackage.repo}`);
		if (catalogPackage.author) lines.push(`Author: ${catalogPackage.author}`);
		if (catalogPackage.license) lines.push(`License: ${catalogPackage.license}`);
		if (catalogPackage.resources) lines.push(`Catalog resources: ${formatList(catalogPackage.resources)}`);
		if (catalogPackage.compatibility?.volt) lines.push(`Volt compatibility: ${catalogPackage.compatibility.volt}`);
		lines.push("");
	} else {
		lines.push(chalk.bold(resolved.input));
		lines.push(`Source: ${resolved.source}`);
		lines.push("");
	}

	lines.push(chalk.bold("Package metadata"));
	lines.push(`Name: ${inspection.packageName ?? "unknown"}`);
	lines.push(`Version: ${inspection.packageVersion ?? "unknown"}`);
	lines.push(`Description: ${inspection.packageDescription ?? "unknown"}`);
	lines.push(`License: ${inspection.packageLicense ?? "unknown"}`);
	lines.push(`Repository: ${inspection.packageRepository ?? "unknown"}`);
	lines.push(...renderVoltManifest(inspection.voltManifest));
	lines.push(...renderDiscoveredResources(inspection));
	lines.push(...renderRecord("Dependencies", inspection.dependencies));
	lines.push(...renderRecord("Peer dependencies", inspection.peerDependencies));
	lines.push(...renderRecord("Optional dependencies", inspection.optionalDependencies));
	lines.push(...renderRecord("Scripts", inspection.scripts));
	lines.push(...renderWarnings([...resolved.warnings, ...inspection.warnings]));
	return lines.join("\n");
}

export function renderStoreInstallPlan(plan: StoreInstallPlan): string {
	const lines = [
		chalk.bold("Store install plan"),
		`Input: ${plan.input}`,
		`Source: ${plan.source}`,
		`Scope: ${plan.scope}`,
		`Tracking: ${plan.tracking ? "yes" : "no"}`,
		`Script policy: ${plan.scriptPolicy}`,
		`Compatibility: ${plan.compatibility}`,
		"",
		chalk.bold("Package metadata"),
		`Name: ${plan.inspection.packageName ?? "unknown"}`,
		`Version: ${plan.inspection.packageVersion ?? "unknown"}`,
		`Description: ${plan.inspection.packageDescription ?? "unknown"}`,
		`License: ${plan.inspection.packageLicense ?? "unknown"}`,
		`Repository: ${plan.inspection.packageRepository ?? "unknown"}`,
		...renderVoltManifest(plan.inspection.voltManifest),
		...renderDiscoveredResources(plan.inspection),
		...renderRecord("Dependencies", plan.inspection.dependencies),
		...renderRecord("Peer dependencies", plan.inspection.peerDependencies),
		...renderRecord("Optional dependencies", plan.inspection.optionalDependencies),
		...renderRecord("Scripts", plan.inspection.scripts),
		...renderWarnings(plan.warnings),
	];
	return lines.join("\n");
}
