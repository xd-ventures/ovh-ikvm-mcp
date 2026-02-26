import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OvhProvider } from "../../../src/providers/ovh/provider.js";
import { MockOvhApi } from "../../helpers/mock-ovh-api.js";
import { TestVncServer } from "../../helpers/vnc-server.js";

describe("OvhProvider.listServers", () => {
	let mockApi: MockOvhApi;
	let baseUrl: string;
	let provider: OvhProvider;

	beforeAll(() => {
		mockApi = new MockOvhApi({
			servers: ["ns1234.ip-1-2-3.eu", "ks5678.kimsufi.com"],
			serverDetails: {
				"ns1234.ip-1-2-3.eu": {
					name: "ns1234.ip-1-2-3.eu",
					datacenter: "sbg3",
					ip: "1.2.3.4",
				},
				"ks5678.kimsufi.com": {
					name: "ks5678.kimsufi.com",
					datacenter: "gra1",
					ip: "5.6.7.8",
				},
			},
		});
		baseUrl = mockApi.start();
		provider = new OvhProvider({
			endpoint: "eu",
			applicationKey: "test-ak",
			applicationSecret: "test-as",
			consumerKey: "test-ck",
			baseUrl,
		});
	});

	afterAll(() => {
		mockApi.stop();
	});

	it("should return normalized Server objects", async () => {
		const servers = await provider.listServers();

		expect(servers).toHaveLength(2);
		expect(servers[0]).toEqual({
			id: "ns1234.ip-1-2-3.eu",
			name: "ns1234.ip-1-2-3.eu",
			provider: "ovh",
			datacenter: "sbg3",
			ip: "1.2.3.4",
		});
		expect(servers[1]).toEqual({
			id: "ks5678.kimsufi.com",
			name: "ks5678.kimsufi.com",
			provider: "ovh",
			datacenter: "gra1",
			ip: "5.6.7.8",
		});
	});

	it("should return empty array when no servers", async () => {
		const emptyMock = new MockOvhApi({ servers: [] });
		const emptyUrl = emptyMock.start();
		const emptyProvider = new OvhProvider({
			endpoint: "eu",
			applicationKey: "test-ak",
			applicationSecret: "test-as",
			consumerKey: "test-ck",
			baseUrl: emptyUrl,
		});

		const servers = await emptyProvider.listServers();
		expect(servers).toEqual([]);
		emptyMock.stop();
	});

	it("should set provider field to 'ovh'", async () => {
		const servers = await provider.listServers();
		for (const server of servers) {
			expect(server.provider).toBe("ovh");
		}
	});
});

describe("OvhProvider.getScreenshot", () => {
	let mockApi: MockOvhApi;
	let vncServer: TestVncServer;
	let mockViewerServer: ReturnType<typeof Bun.serve> | null = null;
	let provider: OvhProvider;

	beforeAll(() => {
		// Start a test VNC server that serves a known image
		vncServer = new TestVncServer({
			width: 320,
			height: 240,
			fillColor: [255, 0, 0],
		});
		vncServer.start();

		// Start a mock viewer HTML page that references the VNC WebSocket
		mockViewerServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/viewer.html") {
					return new Response(
						`<!DOCTYPE html>
<html>
<head><title>KVM Viewer</title></head>
<body>
<script>
var host = "localhost";
var port = "${vncServer.port}";
var path = "";
</script>
</body>
</html>`,
						{ headers: { "Content-Type": "text/html" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const viewerUrl = `http://localhost:${mockViewerServer.port}/viewer.html`;

		// Start mock OVH API that returns the viewer URL
		mockApi = new MockOvhApi({
			servers: ["test-server"],
			serverDetails: {
				"test-server": {
					name: "test-server",
					datacenter: "sbg3",
					ip: "1.2.3.4",
				},
			},
			viewerUrls: {
				"test-server": viewerUrl,
			},
			autoCompleteTasks: true,
		});
		const apiUrl = mockApi.start();

		provider = new OvhProvider(
			{
				endpoint: "eu",
				applicationKey: "test-ak",
				applicationSecret: "test-as",
				consumerKey: "test-ck",
				baseUrl: apiUrl,
			},
			{
				publicIp: "127.0.0.1",
				pollInterval: 10,
				pollMaxAttempts: 5,
			},
		);
	});

	afterAll(() => {
		mockApi.stop();
		vncServer.stop();
		if (mockViewerServer) {
			mockViewerServer.stop(true);
		}
	});

	it("should capture a screenshot and return PNG buffer", async () => {
		const png = await provider.getScreenshot("test-server");

		expect(png).toBeInstanceOf(Buffer);
		// PNG magic bytes
		expect(png[0]).toBe(0x89);
		expect(png[1]).toBe(0x50); // P
		expect(png[2]).toBe(0x4e); // N
		expect(png[3]).toBe(0x47); // G
	});
});
