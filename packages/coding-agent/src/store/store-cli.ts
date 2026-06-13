import { createInterface } from "node:readline";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import type { ExtensionFactory } from "../core/extensions/types.ts";
import type { PackageInstallScriptPolicy } from "../core/package-manager.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	createCommandSettingsManager,
	getCommandAppMode,
	parseProjectTrustOverride,
	reportProjectTrustWarnings,
	reportSettingsErrors,
} from "../package-manager-cli.ts";
import { findCatalogPackage, loadDefaultStoreCatalog, type StoreCatalog, searchCatalogPackages } from "./catalog.ts";
import { inspectStorePackage } from "./inspector.ts";
import {
	buildStoreInstallPlan,
	type StoreInstallPlan,
	type StoreInstallScope,
	type StoreInstallScriptPolicy,
} from "./install-plan.ts";
import { renderCatalogSearch, renderStoreInstallPlan, renderStoreShow } from "./render.ts";
import { resolveStoreSource } from "./resolver.ts";
import { chooseStoreRemoveTarget, chooseStoreUpdateTarget } from "./targets.ts";

type StoreCommand = "search" | "show" | "install" | "remove" | "update";

interface StoreCommandOptions {
	command: StoreCommand;
	input?: string;
	query?: string;
	local: boolean;
	yes: boolean;
	track: boolean;
	scriptPolicy: StoreInstallScriptPolicy;
	ref?: string;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

export interface StoreCommandRuntimeOptions {
	extensionFactories?: ExtensionFactory[];
}

function getStoreCommandUsage(command?: StoreCommand): string {
	switch (command) {
		case "search":
			return `${APP_NAME} store search [query] [--approve|--no-approve]`;
		case "show":
			return `${APP_NAME} store show <id|source> [--approve|--no-approve]`;
		case "install":
			return `${APP_NAME} store install <id|source> [-l] [--ref <ref>] [--track] [--scripts ask|never|allow] [--yes] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} store remove <id|source> [-l] [--yes] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} store update [id|source] [--yes] [--approve|--no-approve]`;
		default:
			return `${APP_NAME} store <search|show|install|remove|update>`;
	}
}

function printStoreHelp(command?: StoreCommand): void {
	if (!command) {
		console.log(`${chalk.bold("Usage:")}
  ${getStoreCommandUsage()}

Commands:
  search [query]       Search catalog packages
  show <id|source>     Show catalog and package metadata
  install <id|source>  Inspect, plan, and install a package
  remove <id|source>   Remove an installed package by catalog ID or source
  update [id|source]   Update installed packages or upgrade from a catalog entry
`);
		return;
	}

	console.log(`${chalk.bold("Usage:")}
  ${getStoreCommandUsage(command)}
`);
}

function parseStoreCommand(args: string[]): StoreCommandOptions | undefined {
	if (args[0] !== "store") {
		return undefined;
	}
	const rawCommand = args[1];
	if (!rawCommand || rawCommand === "-h" || rawCommand === "--help") {
		return {
			command: "search",
			local: false,
			yes: false,
			track: false,
			scriptPolicy: "never",
			projectTrustOverride: parseProjectTrustOverride(args),
			help: true,
		};
	}
	if (
		rawCommand !== "search" &&
		rawCommand !== "show" &&
		rawCommand !== "install" &&
		rawCommand !== "remove" &&
		rawCommand !== "update"
	) {
		return {
			command: "search",
			local: false,
			yes: false,
			track: false,
			scriptPolicy: "never",
			projectTrustOverride: parseProjectTrustOverride(args),
			help: false,
			invalidArgument: rawCommand,
		};
	}

	const command = rawCommand;
	const rest = args.slice(2);
	let local = false;
	let yes = false;
	let track = false;
	let scriptPolicy: StoreInstallScriptPolicy = "never";
	let ref: string | undefined;
	let help = false;
	let projectTrustOverride: boolean | undefined;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	const positionals: string[] = [];

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--yes" || arg === "-y") {
			if (command === "install" || command === "remove" || command === "update") {
				yes = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--track") {
			if (command === "install") {
				track = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}
		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}
		if (arg === "--ref") {
			if (command !== "install") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (ref !== undefined) {
				conflictingOptions = conflictingOptions ?? "--ref can only be provided once";
				index++;
			} else {
				ref = value;
				index++;
			}
			continue;
		}
		if (arg === "--scripts") {
			if (command !== "install") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (value !== "ask" && value !== "never" && value !== "allow") {
				conflictingOptions = conflictingOptions ?? "--scripts must be ask, never, or allow";
				index++;
			} else {
				scriptPolicy = value;
				index++;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		positionals.push(arg);
	}

	if (command === "search") {
		if (positionals.length > 1) {
			invalidArgument = invalidArgument ?? positionals[1];
		}
		return {
			command,
			query: positionals[0],
			local,
			yes,
			track,
			scriptPolicy,
			projectTrustOverride,
			help,
			invalidOption,
			invalidArgument,
			missingOptionValue,
			conflictingOptions,
		};
	}

	if (command === "update") {
		if (positionals.length > 1) {
			invalidArgument = invalidArgument ?? positionals[1];
		}
		return {
			command,
			input: positionals[0],
			local,
			yes,
			track,
			scriptPolicy,
			projectTrustOverride,
			help,
			invalidOption,
			invalidArgument,
			missingOptionValue,
			conflictingOptions,
		};
	}

	if (positionals.length > 1) {
		invalidArgument = invalidArgument ?? positionals[1];
	}

	return {
		command,
		input: positionals[0],
		local,
		yes,
		track,
		scriptPolicy,
		...(ref !== undefined ? { ref } : {}),
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			const normalized = answer.trim().toLowerCase();
			resolve(normalized === "y" || normalized === "yes");
		});
	});
}

function reportCatalogWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function loadCatalog(agentDir: string, options: { required: boolean }): Promise<StoreCatalog | undefined> {
	try {
		const result = await loadDefaultStoreCatalog({ agentDir });
		reportCatalogWarnings(result.warnings);
		return result.catalog;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (!options.required) {
			console.error(chalk.yellow(`Warning: ${message}; continuing without catalog metadata.`));
			return { schemaVersion: 1, packages: [] };
		}
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return undefined;
	}
}

function hasDirectScripts(plan: StoreInstallPlan): boolean {
	return Object.keys(plan.inspection.scripts).length > 0;
}

async function resolveScriptPolicyForInstall(plan: StoreInstallPlan): Promise<PackageInstallScriptPolicy | undefined> {
	if (plan.scriptPolicy === "allow") {
		return "allow";
	}
	if (plan.scriptPolicy === "never" || !hasDirectScripts(plan)) {
		return "never";
	}
	if (getCommandAppMode() !== "interactive") {
		console.error(chalk.red("Package scripts require interactive confirmation or --scripts allow."));
		process.exitCode = 1;
		return undefined;
	}
	const allow = await promptConfirm("Allow package lifecycle scripts for this install?");
	return allow ? "allow" : "never";
}

async function confirmMutation(options: { yes: boolean; action: string }): Promise<boolean> {
	if (options.yes) {
		return true;
	}
	if (getCommandAppMode() !== "interactive") {
		console.error(chalk.red(`Non-interactive ${options.action} requires --yes.`));
		process.exitCode = 1;
		return false;
	}
	const confirmed = await promptConfirm(`Proceed with store ${options.action}?`);
	if (!confirmed) {
		console.log(chalk.dim("Aborted."));
	}
	return confirmed;
}

async function runSearch(options: StoreCommandOptions, agentDir: string): Promise<boolean> {
	const catalog = await loadCatalog(agentDir, { required: true });
	if (!catalog) {
		return true;
	}
	console.log(renderCatalogSearch(searchCatalogPackages(catalog, options.query), options.query));
	return true;
}

async function runShow(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store show source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("show")}`));
		process.exitCode = 1;
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({ input, catalog, pinGit: false });
	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	console.log(renderStoreShow(resolved, inspection));
	return true;
}

async function runInstall(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store install source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("install")}`));
		process.exitCode = 1;
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({
		input,
		catalog,
		track: options.track,
		ref: options.ref,
		pinGit: true,
	});
	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	const scope: StoreInstallScope = options.local ? "project" : "user";
	const plan = buildStoreInstallPlan({
		resolved,
		inspection,
		scope,
		scriptPolicy: options.scriptPolicy,
	});
	console.log(renderStoreInstallPlan(plan));

	if (!(await confirmMutation({ yes: options.yes, action: "install" }))) {
		return true;
	}
	const scripts = await resolveScriptPolicyForInstall(plan);
	if (!scripts) {
		return true;
	}

	await packageManager.installAndPersist(plan.source, { local: options.local, scripts });
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const installedPath = packageManager.getInstalledPath(plan.source, scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		if (installedPath) {
			console.error(chalk.yellow(`Package was installed at ${installedPath}, but settings persistence failed.`));
		}
		process.exitCode = 1;
		return true;
	}

	console.log(chalk.green(`Installed ${plan.source}`));
	return true;
}

async function runRemove(
	options: StoreCommandOptions,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store remove source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("remove")}`));
		process.exitCode = 1;
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({ input, catalog, pinGit: false });
	const selection = chooseStoreRemoveTarget(packageManager, resolved.source, options.local);
	if (selection.conflict === "both-scopes") {
		console.error(chalk.red("Package is installed in both user and project scopes. Use -l to remove project scope."));
		process.exitCode = 1;
		return true;
	}
	const target = selection.target;
	if (!target) {
		if (process.exitCode === undefined) {
			console.error(chalk.red(`No matching package found for ${input}`));
			process.exitCode = 1;
		}
		return true;
	}

	console.log(`Removing ${target.source} from ${target.scope} scope.`);
	if (!(await confirmMutation({ yes: options.yes, action: "remove" }))) {
		return true;
	}
	const removed = await packageManager.removeAndPersist(resolved.source, { local: target.scope === "project" });
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		process.exitCode = 1;
		return true;
	}
	if (!removed) {
		console.error(chalk.red(`No matching package found for ${input}`));
		process.exitCode = 1;
		return true;
	}
	console.log(chalk.green(`Removed ${target.source}`));
	return true;
}

async function runUpdate(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		await packageManager.update(undefined, { scripts: "never" });
		console.log(chalk.green("Updated packages"));
		return true;
	}

	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const catalogPackage = findCatalogPackage(catalog, input);
	if (!catalogPackage) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		await packageManager.update(input, { scripts: "never" });
		console.log(chalk.green(`Updated ${input}`));
		return true;
	}

	const resolved = await resolveStoreSource({ input, catalog, pinGit: true });
	const selection = chooseStoreUpdateTarget(packageManager, resolved.source);
	if (selection.conflict === "both-scopes") {
		console.error(chalk.red("Package is installed in both user and project scopes. Update one scope directly."));
		process.exitCode = 1;
		return true;
	}
	const target = selection.target;
	if (!target) {
		if (process.exitCode === undefined) {
			console.error(chalk.red(`No matching installed package found for catalog ID ${input}`));
			process.exitCode = 1;
		}
		return true;
	}

	if (target.source === resolved.source) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		await packageManager.update(target.source, { scripts: "never" });
		console.log(chalk.green(`Updated ${target.source}`));
		return true;
	}

	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	const plan = buildStoreInstallPlan({
		resolved,
		inspection,
		scope: target.scope,
		scriptPolicy: "never",
	});
	console.log(renderStoreInstallPlan(plan));
	if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
		return true;
	}
	await packageManager.installAndPersist(plan.source, {
		local: target.scope === "project",
		scripts: "never",
	});
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const installedPath = packageManager.getInstalledPath(plan.source, target.scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		if (installedPath) {
			console.error(chalk.yellow(`Package was installed at ${installedPath}, but settings persistence failed.`));
		}
		process.exitCode = 1;
		return true;
	}
	console.log(chalk.green(`Updated ${target.source} to ${plan.source}`));
	return true;
}

export async function handleStoreCommand(
	args: string[],
	runtimeOptions: StoreCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parseStoreCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printStoreHelp(args[1] as StoreCommand | undefined);
		return true;
	}
	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "store ${options.command}".`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = options.local && (options.command === "install" || options.command === "remove");
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "store command");

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "search":
				return await runSearch(options, agentDir);
			case "show":
				return await runShow(options, cwd, agentDir, settingsManager);
			case "install":
				return await runInstall(options, cwd, agentDir, settingsManager, packageManager);
			case "remove":
				return await runRemove(options, agentDir, settingsManager, packageManager);
			case "update":
				return await runUpdate(options, cwd, agentDir, settingsManager, packageManager);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown store command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
