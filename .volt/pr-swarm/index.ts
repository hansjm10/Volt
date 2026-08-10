import { pathToFileURL } from "node:url";
import { NodeCommandAdapter } from "./command.ts";
import { formatSwarmUsage, parseSwarmArgs, SwarmHelpError } from "./config.ts";
import { VoltDaemonAdapter } from "./daemon.ts";
import { CommandGitAdapter } from "./git.ts";
import { GhCliAdapter } from "./github.ts";
import { FileStateStore } from "./state.ts";
import { SwarmController } from "./swarm.ts";
import { TerminalSwarmReporter } from "./ui.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
	let config;
	try {
		config = parseSwarmArgs(argv);
	} catch (error) {
		if (error instanceof SwarmHelpError) {
			console.log(error.message);
			return;
		}
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${formatSwarmUsage()}`);
	}

	const commands = new NodeCommandAdapter();
	const github = new GhCliAdapter({ commands, cwd: config.cwd });
	await github.assertAuthenticated();
	const { repository } = await github.resolveRepository();
	const daemon = new VoltDaemonAdapter({
		workspaceName: config.workspaceName,
		swarmDir: config.swarmDir,
	});
	const git = new CommandGitAdapter(commands, config.cwd);
	const stateStore = new FileStateStore(config.swarmDir, repository, config.prNumber);
	const logger = new TerminalSwarmReporter({ dryRun: config.dryRun });
	const controller = new SwarmController(config, { github, git, daemon, stateStore, logger });
	const abortController = new AbortController();
	const stop = (signal: NodeJS.Signals) => abortController.abort(new Error(`Received ${signal}`));
	const onSigint = () => stop("SIGINT");
	const onSigterm = () => stop("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		await controller.run(abortController.signal);
	} catch (error) {
		if (!abortController.signal.aborted) throw error;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
}
