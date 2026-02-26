import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OvhApiClient } from "../../../src/providers/ovh/api.js";
import { MockOvhApi } from "../../helpers/mock-ovh-api.js";

describe("OvhApiClient", () => {
	const testConfig = {
		endpoint: "eu",
		applicationKey: "test-ak",
		applicationSecret: "test-as",
		consumerKey: "test-ck",
	};

	it("should construct with valid endpoint", () => {
		const client = new OvhApiClient(testConfig);
		expect(client).toBeDefined();
	});

	it("should construct with custom baseUrl", () => {
		const client = new OvhApiClient({ ...testConfig, baseUrl: "http://localhost:9999" });
		expect(client).toBeDefined();
	});

	it("should throw on invalid endpoint", () => {
		expect(() => {
			new OvhApiClient({ ...testConfig, endpoint: "invalid" });
		}).toThrow("Unknown OVH endpoint");
	});

	describe("request signing", () => {
		it("should produce a $1$ prefixed SHA1 signature", () => {
			const client = new OvhApiClient(testConfig);
			const sig = client.sign("GET", "https://eu.api.ovh.com/1.0/dedicated/server", "", 1234567890);

			expect(sig).toMatch(/^\$1\$[a-f0-9]{40}$/);
		});

		it("should produce consistent signatures for same inputs", () => {
			const client = new OvhApiClient(testConfig);
			const sig1 = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 1000);
			const sig2 = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 1000);

			expect(sig1).toBe(sig2);
		});

		it("should produce different signatures for different methods", () => {
			const client = new OvhApiClient(testConfig);
			const sig1 = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 1000);
			const sig2 = client.sign("POST", "https://eu.api.ovh.com/1.0/test", "", 1000);

			expect(sig1).not.toBe(sig2);
		});

		it("should produce different signatures for different timestamps", () => {
			const client = new OvhApiClient(testConfig);
			const sig1 = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 1000);
			const sig2 = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 2000);

			expect(sig1).not.toBe(sig2);
		});

		it("should match known OVH signature format", () => {
			// The signature is SHA1(AS+CK+METHOD+URL+BODY+TIMESTAMP)
			const client = new OvhApiClient({
				endpoint: "eu",
				applicationKey: "ak",
				applicationSecret: "AS",
				consumerKey: "CK",
			});

			const sig = client.sign("GET", "https://eu.api.ovh.com/1.0/test", "", 1000);

			// Manually compute expected: SHA1("AS+CK+GET+https://eu.api.ovh.com/1.0/test++1000")
			const hasher = new Bun.CryptoHasher("sha1");
			hasher.update("AS+CK+GET+https://eu.api.ovh.com/1.0/test++1000");
			const expected = `$1$${hasher.digest("hex")}`;

			expect(sig).toBe(expected);
		});
	});
});

describe("OvhApiClient integration", () => {
	let mockApi: MockOvhApi;
	let baseUrl: string;
	let client: OvhApiClient;

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
		client = new OvhApiClient({
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

	it("should sync time with the server", async () => {
		await expect(client.syncTime()).resolves.toBeUndefined();
	});

	it("should send correct auth headers on GET", async () => {
		await client.syncTime();
		await client.get<string[]>("/dedicated/server");

		const req = mockApi.requests.find((r) => r.method === "GET" && r.path === "/dedicated/server");
		expect(req).toBeDefined();
		expect(req?.headers["x-ovh-application"]).toBe("test-ak");
		expect(req?.headers["x-ovh-consumer"]).toBe("test-ck");
		expect(req?.headers["x-ovh-timestamp"]).toBeDefined();
		expect(req?.headers["x-ovh-signature"]).toMatch(/^\$1\$/);
	});

	it("should list dedicated servers", async () => {
		await client.syncTime();
		const servers = await client.get<string[]>("/dedicated/server");

		expect(servers).toEqual(["ns1234.ip-1-2-3.eu", "ks5678.kimsufi.com"]);
	});

	it("should get server details", async () => {
		await client.syncTime();
		const details = await client.get<{ name: string; datacenter: string }>(
			"/dedicated/server/ns1234.ip-1-2-3.eu",
		);

		expect(details.name).toBe("ns1234.ip-1-2-3.eu");
		expect(details.datacenter).toBe("sbg3");
	});

	it("should throw on 404 for unknown server", async () => {
		await client.syncTime();
		await expect(client.get("/dedicated/server/unknown-server")).rejects.toThrow("404");
	});

	it("should send POST with body", async () => {
		await client.syncTime();
		const result = await client.post<{ taskId: number }>(
			"/dedicated/server/ns1234.ip-1-2-3.eu/features/ipmi/access",
			{ type: "kvmipHtml5URL", ttl: 15, ipToAllow: "1.2.3.4" },
		);

		expect(result.taskId).toBeGreaterThan(0);
	});
});
