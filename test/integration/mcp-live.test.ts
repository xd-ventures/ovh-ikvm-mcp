// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Live integration test: exercises the full MCP server against a real OVH account.
 *
 * Requires OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY env vars.
 * Skipped automatically when credentials are absent.
 *
 * Run manually: bun test test/integration/mcp-live.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PNG } from "pngjs";
import { createMcpServer } from "../../src/mcp/server.js";
import { OvhProvider } from "../../src/providers/ovh/provider.js";

const hasCredentials =
	!!process.env.OVH_APPLICATION_KEY &&
	!!process.env.OVH_APPLICATION_SECRET &&
	!!process.env.OVH_CONSUMER_KEY;

describe.skipIf(!hasCredentials)("MCP Live Integration", () => {
	let client: Client;
	let mcpServer: McpServer;

	beforeAll(async () => {
		const provider = new OvhProvider({
			endpoint: process.env.OVH_ENDPOINT || "eu",
			applicationKey: process.env.OVH_APPLICATION_KEY ?? "",
			applicationSecret: process.env.OVH_APPLICATION_SECRET ?? "",
			consumerKey: process.env.OVH_CONSUMER_KEY ?? "",
		});

		mcpServer = createMcpServer(provider);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await mcpServer.connect(serverTransport);

		client = new Client({ name: "live-test", version: "1.0" });
		await client.connect(clientTransport);
	});

	afterAll(async () => {
		await client?.close();
		await mcpServer?.close();
	});

	it("should list servers via MCP", async () => {
		const result = await client.callTool({ name: "list_servers", arguments: {} });
		const content = result.content as Array<{ type: string; text: string }>;

		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("text");

		const servers = JSON.parse(content[0].text);
		expect(servers.length).toBeGreaterThan(0);
		expect(servers[0]).toHaveProperty("id");
		expect(servers[0]).toHaveProperty("provider", "ovh");
		const ids = servers.map((s: { id: string }) => s.id).join(", ");
		console.log(`Found ${servers.length} server(s): ${ids}`);
	}, 30_000);

	it("should capture an optimized screenshot via MCP", async () => {
		// Get first server
		const listResult = await client.callTool({ name: "list_servers", arguments: {} });
		const listContent = listResult.content as Array<{ type: string; text: string }>;
		const servers = JSON.parse(listContent[0].text);
		const serverId = servers[0].id;

		// Capture screenshot (default = optimized)
		const result = await client.callTool({
			name: "get_screenshot",
			arguments: { serverId },
		});

		expect(result.isError).not.toBe(true);

		const content = result.content as Array<{
			type: string;
			data: string;
			mimeType: string;
		}>;
		expect(content[0].type).toBe("image");
		expect(content[0].mimeType).toBe("image/png");

		const pngBuf = Buffer.from(content[0].data, "base64");
		const png = PNG.sync.read(pngBuf);
		// Optimized output should be 2x the raw BMC dimensions (typically 1600x1200)
		expect(png.width).toBeGreaterThan(0);
		expect(png.height).toBeGreaterThan(0);
		console.log(`Screenshot: ${png.width}x${png.height} (${pngBuf.length} bytes)`);
	}, 120_000);

	it("should capture a raw screenshot when raw=true", async () => {
		const listResult = await client.callTool({ name: "list_servers", arguments: {} });
		const listContent = listResult.content as Array<{ type: string; text: string }>;
		const servers = JSON.parse(listContent[0].text);
		const serverId = servers[0].id;

		const result = await client.callTool({
			name: "get_screenshot",
			arguments: { serverId, raw: true },
		});

		expect(result.isError).not.toBe(true);

		const content = result.content as Array<{
			type: string;
			data: string;
			mimeType: string;
		}>;
		const pngBuf = Buffer.from(content[0].data, "base64");
		const png = PNG.sync.read(pngBuf);
		// Raw BMC output is typically 800x600
		expect(png.width).toBeGreaterThan(0);
		expect(png.height).toBeGreaterThan(0);
		console.log(`Raw screenshot: ${png.width}x${png.height} (${pngBuf.length} bytes)`);
	}, 120_000);
});
