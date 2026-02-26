import { describe, expect, it } from "bun:test";
import { OvhApiClient } from "../../../src/providers/ovh/api.js";

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
