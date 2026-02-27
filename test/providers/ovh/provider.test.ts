// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OvhProvider } from "../../../src/providers/ovh/provider.js";
import { MockBmcServer } from "../../helpers/mock-bmc-server.js";
import { MockOvhApi } from "../../helpers/mock-ovh-api.js";

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
	let bmcServer: MockBmcServer;
	let provider: OvhProvider;

	beforeAll(() => {
		// Start a mock BMC server that serves a test JPEG frame
		bmcServer = new MockBmcServer({
			width: 320,
			height: 240,
			fillColor: [255, 0, 0],
			sessionCookie: "test-session-id",
			csrfToken: "test-csrf",
		});
		const bmcUrl = bmcServer.start();

		// The mock OVH API returns the BMC viewer URL
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
				"test-server": `${bmcUrl}/viewer`,
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
		bmcServer.stop();
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

describe("OvhProvider.waitForTask edge cases", () => {
	it("should throw on task timeout when task never completes", async () => {
		const mockApi = new MockOvhApi({
			servers: ["timeout-server"],
			serverDetails: {
				"timeout-server": { name: "timeout-server", datacenter: "sbg3", ip: "1.2.3.4" },
			},
			viewerUrls: {},
			autoCompleteTasks: false, // tasks stay "doing"
		});
		const baseUrl = mockApi.start();

		const provider = new OvhProvider(
			{
				endpoint: "eu",
				applicationKey: "test-ak",
				applicationSecret: "test-as",
				consumerKey: "test-ck",
				baseUrl,
			},
			{
				publicIp: "127.0.0.1",
				pollInterval: 10,
				pollMaxAttempts: 3, // only 3 attempts → fast timeout
			},
		);

		await expect(provider.getScreenshot("timeout-server")).rejects.toThrow("timed out");
		mockApi.stop();
	});

	it("should throw on task failure with cancelled status", async () => {
		const mockApi = new MockOvhApi({
			servers: ["fail-server"],
			serverDetails: {
				"fail-server": { name: "fail-server", datacenter: "gra1", ip: "5.6.7.8" },
			},
			autoCompleteTasks: false,
		});
		const baseUrl = mockApi.start();

		const provider = new OvhProvider(
			{
				endpoint: "eu",
				applicationKey: "test-ak",
				applicationSecret: "test-as",
				consumerKey: "test-ck",
				baseUrl,
			},
			{
				publicIp: "127.0.0.1",
				pollInterval: 10,
				pollMaxAttempts: 10,
			},
		);

		// Start the getScreenshot call, then fail the task after a short delay
		const promise = provider.getScreenshot("fail-server");

		// Wait for the task to be created, then fail it
		await new Promise((resolve) => setTimeout(resolve, 20));
		mockApi.failTask(1, "cancelled", "Cancelled by user");

		await expect(promise).rejects.toThrow("cancelled");
		mockApi.stop();
	});

	it("should throw on task failure with ovhError status", async () => {
		const mockApi = new MockOvhApi({
			servers: ["error-server"],
			serverDetails: {
				"error-server": { name: "error-server", datacenter: "gra1", ip: "5.6.7.8" },
			},
			autoCompleteTasks: false,
		});
		const baseUrl = mockApi.start();

		const provider = new OvhProvider(
			{
				endpoint: "eu",
				applicationKey: "test-ak",
				applicationSecret: "test-as",
				consumerKey: "test-ck",
				baseUrl,
			},
			{
				publicIp: "127.0.0.1",
				pollInterval: 10,
				pollMaxAttempts: 10,
			},
		);

		const promise = provider.getScreenshot("error-server");

		await new Promise((resolve) => setTimeout(resolve, 20));
		mockApi.failTask(1, "ovhError", "Internal error");

		await expect(promise).rejects.toThrow("ovhError");
		mockApi.stop();
	});
});
