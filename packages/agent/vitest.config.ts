import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		maxWorkers: 8,
		minWorkers: 1,
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/volt-ai$/, replacement: aiSrcIndex }],
	},
});
