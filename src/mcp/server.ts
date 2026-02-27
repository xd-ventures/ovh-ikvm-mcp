// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * MCP server setup with tool definitions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { optimizeForLlm } from "../kvm/optimize.js";
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
		"Capture a screenshot of a server's iKVM/IPMI console screen. Returns a PNG image optimized for LLM vision (2x upscale + brightness boost). Set raw=true to get the original unprocessed image.",
		{
			serverId: z.string().describe("Server identifier (e.g., 'ns1234567.ip-1-2-3.eu')"),
			raw: z
				.boolean()
				.optional()
				.default(false)
				.describe("Return the raw screenshot without LLM optimization"),
		},
		async ({ serverId, raw }) => {
			const png = await provider.getScreenshot(serverId);
			const outputPng = raw ? png : optimizeForLlm(png);
			return {
				content: [
					{
						type: "image",
						data: outputPng.toString("base64"),
						mimeType: "image/png",
					},
				],
			};
		},
	);

	return server;
}
