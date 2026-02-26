import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";
import { createMcpServer } from "../../src/mcp/server.js";
import type { Provider, Server } from "../../src/providers/types.js";

/** Create a pair of in-memory transports connected to each other. */
function createTransportPair(): [Transport, Transport] {
	let onMessageA: ((msg: JSONRPCMessage) => void) | undefined;
	let onMessageB: ((msg: JSONRPCMessage) => void) | undefined;
	let onCloseA: (() => void) | undefined;
	let onCloseB: (() => void) | undefined;

	const transportA: Transport = {
		async start() {},
		async send(msg) {
			// A sends → B receives
			onMessageB?.(msg);
		},
		async close() {
			onCloseA?.();
			onCloseB?.();
		},
		set onmessage(handler: ((msg: JSONRPCMessage) => void) | undefined) {
			onMessageA = handler;
		},
		get onmessage() {
			return onMessageA;
		},
		set onclose(handler: (() => void) | undefined) {
			onCloseA = handler;
		},
		get onclose() {
			return onCloseA;
		},
	};

	const transportB: Transport = {
		async start() {},
		async send(msg) {
			// B sends → A receives
			onMessageA?.(msg);
		},
		async close() {
			onCloseA?.();
			onCloseB?.();
		},
		set onmessage(handler: ((msg: JSONRPCMessage) => void) | undefined) {
			onMessageB = handler;
		},
		get onmessage() {
			return onMessageB;
		},
		set onclose(handler: (() => void) | undefined) {
			onCloseB = handler;
		},
		get onclose() {
			return onCloseB;
		},
	};

	return [transportA, transportB];
}

/** Test PNG: 1x1 red pixel */
const TEST_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
	"base64",
);

class MockProvider implements Provider {
	readonly name = "mock";
	screenshotError: Error | null = null;

	async listServers(): Promise<Server[]> {
		return [
			{ id: "server-1", name: "server-1", provider: "mock", datacenter: "dc1", ip: "1.2.3.4" },
			{ id: "server-2", name: "server-2", provider: "mock", datacenter: "dc2", ip: "5.6.7.8" },
		];
	}

	async getScreenshot(_serverId: string): Promise<Buffer> {
		if (this.screenshotError) {
			throw this.screenshotError;
		}
		return TEST_PNG;
	}
}

describe("MCP Server", () => {
	let client: Client;
	let serverTransport: Transport;
	let clientTransport: Transport;
	let mockProvider: MockProvider;

	beforeAll(async () => {
		mockProvider = new MockProvider();
		const mcpServer = createMcpServer(mockProvider);

		[clientTransport, serverTransport] = createTransportPair();

		await mcpServer.connect(serverTransport);
		client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
	});

	afterAll(async () => {
		await client.close();
	});

	it("should list available tools", async () => {
		const result = await client.listTools();
		const toolNames = result.tools.map((t) => t.name);

		expect(toolNames).toContain("list_servers");
		expect(toolNames).toContain("get_screenshot");
	});

	it("should describe list_servers tool", async () => {
		const result = await client.listTools();
		const tool = result.tools.find((t) => t.name === "list_servers");

		expect(tool).toBeDefined();
		expect(tool?.description).toContain("List");
	});

	it("should describe get_screenshot tool", async () => {
		const result = await client.listTools();
		const tool = result.tools.find((t) => t.name === "get_screenshot");

		expect(tool).toBeDefined();
		expect(tool?.description).toContain("screenshot");
	});

	it("should call list_servers and return JSON text content", async () => {
		const result = await client.callTool({ name: "list_servers", arguments: {} });
		const content = result.content as Array<{ type: string; text?: string }>;

		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("text");
		const servers = JSON.parse(content[0].text ?? "");
		expect(servers).toHaveLength(2);
		expect(servers[0].id).toBe("server-1");
		expect(servers[1].id).toBe("server-2");
	});

	it("should call get_screenshot and return image content", async () => {
		const result = await client.callTool({
			name: "get_screenshot",
			arguments: { serverId: "server-1" },
		});
		const content = result.content as Array<{
			type: string;
			data?: string;
			mimeType?: string;
		}>;

		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("image");
		expect(content[0].mimeType).toBe("image/png");
		expect(content[0].data).toBeDefined();
		// Verify it's valid base64
		const decoded = Buffer.from(content[0].data ?? "", "base64");
		expect(decoded[0]).toBe(0x89); // PNG magic
	});

	it("should return LLM-optimized screenshot by default (2x upscale)", async () => {
		const result = await client.callTool({
			name: "get_screenshot",
			arguments: { serverId: "server-1" },
		});
		const content = result.content as Array<{
			type: string;
			data?: string;
			mimeType?: string;
		}>;

		const decoded = Buffer.from(content[0].data ?? "", "base64");
		const png = PNG.sync.read(decoded);
		// Original TEST_PNG is 1x1 → optimized should be 2x2
		expect(png.width).toBe(2);
		expect(png.height).toBe(2);
	});

	it("should return raw screenshot when raw=true", async () => {
		const result = await client.callTool({
			name: "get_screenshot",
			arguments: { serverId: "server-1", raw: true },
		});
		const content = result.content as Array<{
			type: string;
			data?: string;
			mimeType?: string;
		}>;

		const decoded = Buffer.from(content[0].data ?? "", "base64");
		const png = PNG.sync.read(decoded);
		// Raw should preserve original 1x1 dimensions
		expect(png.width).toBe(1);
		expect(png.height).toBe(1);
	});

	it("should propagate provider errors as isError response", async () => {
		mockProvider.screenshotError = new Error("IPMI access denied");
		try {
			const result = await client.callTool({
				name: "get_screenshot",
				arguments: { serverId: "server-1" },
			});

			// MCP SDK wraps tool errors as isError=true with text content
			expect(result.isError).toBe(true);
			const content = result.content as Array<{ type: string; text?: string }>;
			expect(content[0].type).toBe("text");
			expect(content[0].text).toContain("IPMI access denied");
		} finally {
			mockProvider.screenshotError = null;
		}
	});
});
