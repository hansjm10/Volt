import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentSrcNode = fileURLToPath(new URL("../agent/src/node.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: [
			...configDefaults.exclude,
			// This relay fixture uses Node's built-in test runner and is exercised by
			// its own package script. Collecting it in Vitest produces an empty suite.
			"examples/remote/firebase-push-relay/functions/**/*.test.js",
		],
		testTimeout: 30000,
		maxWorkers: 8,
		minWorkers: 1,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@hansjm10\/volt-ai$/, replacement: aiSrcIndex },
			{ find: /^@hansjm10\/volt-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@hansjm10\/volt-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@hansjm10\/volt-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@hansjm10\/volt-tui$/, replacement: tuiSrcIndex },
		],
	},
});
