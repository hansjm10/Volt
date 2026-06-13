import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/volt-agent-core": fileURLToPath(new URL("packages/agent/src/index.ts", repoRoot)),
		"@earendil-works/volt-ai": fileURLToPath(new URL("packages/ai/src/index.ts", repoRoot)),
		"@earendil-works/volt-ai/oauth": fileURLToPath(new URL("packages/ai/src/oauth.ts", repoRoot)),
		"@earendil-works/volt-tui": fileURLToPath(new URL("packages/tui/src/index.ts", repoRoot)),
	},
});

await jiti.import(fileURLToPath(new URL("packages/coding-agent/src/cli.ts", repoRoot)));
