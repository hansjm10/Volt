import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "volt-memory-benchmark", version: "1.0.0" });
server.registerTool(
	"echo",
	{
		description: "Echo benchmark input",
		inputSchema: { text: z.string() },
		annotations: { readOnlyHint: true },
	},
	async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);

await server.connect(new StdioServerTransport());
