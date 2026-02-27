// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Entry point — starts the MCP server with Streamable HTTP transport.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp/server.js";
import { OvhProvider } from "./providers/ovh/provider.js";
import type { OvhConfig } from "./providers/ovh/types.js";

const PORT = Number(process.env.PORT) || 3001;

function loadOvhConfig(): OvhConfig {
	const endpoint = process.env.OVH_ENDPOINT || "eu";
	const applicationKey = process.env.OVH_APPLICATION_KEY;
	const applicationSecret = process.env.OVH_APPLICATION_SECRET;
	const consumerKey = process.env.OVH_CONSUMER_KEY;

	if (!applicationKey || !applicationSecret || !consumerKey) {
		throw new Error(
			"Missing OVH credentials. Set OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY.",
		);
	}

	return { endpoint, applicationKey, applicationSecret, consumerKey };
}

async function main(): Promise<void> {
	const ovhConfig = loadOvhConfig();
	const provider = new OvhProvider(ovhConfig);

	// Store active transports per session for proper lifecycle
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

	const httpServer = Bun.serve({
		port: PORT,
		routes: {
			"/health": () => new Response("ok", { status: 200 }),
			"/mcp": async (req) => {
				const sessionId = req.headers.get("mcp-session-id");

				if (req.method === "POST") {
					const existing = sessionId ? transports.get(sessionId) : undefined;
					if (existing) {
						return existing.handleRequest(req);
					}

					// Each session gets its own McpServer instance
					const mcpServer = createMcpServer(provider);

					const transport = new WebStandardStreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: (sid) => {
							transports.set(sid, transport);
						},
					});

					transport.onclose = () => {
						if (transport.sessionId) {
							transports.delete(transport.sessionId);
						}
					};

					await mcpServer.connect(transport);
					return transport.handleRequest(req);
				}

				const existing = sessionId ? transports.get(sessionId) : undefined;
				if (existing && (req.method === "GET" || req.method === "DELETE")) {
					return existing.handleRequest(req);
				}

				return new Response("Bad Request", { status: 400 });
			},
		},
		fetch() {
			return new Response("Not Found", { status: 404 });
		},
	});

	console.log(`ikvm-mcp server listening on http://localhost:${httpServer.port}/mcp`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
