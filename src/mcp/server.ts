/**
 * MCP server setup with tool definitions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Provider } from "../providers/types.js";

export function createMcpServer(provider: Provider): McpServer {
	const server = new McpServer({
		name: "ikvm-mcp",
		version: "0.1.0",
	});

	server.tool(
		"list_servers",
		"List all available bare metal servers with iKVM/IPMI access",
		{},
		async () => {
			const servers = await provider.listServers();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(servers, null, 2),
					},
				],
			};
		},
	);

	server.tool(
		"get_screenshot",
		"Capture a screenshot of a server's iKVM/IPMI console screen. Returns a PNG image of what is currently displayed on the server's physical monitor output.",
		{
			serverId: z.string().describe("Server identifier (e.g., 'ns1234567.ip-1-2-3.eu')"),
		},
		async ({ serverId }) => {
			const png = await provider.getScreenshot(serverId);
			return {
				content: [
					{
						type: "image",
						data: png.toString("base64"),
						mimeType: "image/png",
					},
				],
			};
		},
	);

	return server;
}
