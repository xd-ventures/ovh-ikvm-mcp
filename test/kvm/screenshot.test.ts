import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { clearDecoderCache } from "../../src/kvm/decoder-fetcher.js";
import { captureKvmScreenshot } from "../../src/kvm/screenshot.js";
import { MockBmcServer } from "../helpers/mock-bmc-server.js";

describe("captureKvmScreenshot", () => {
	let bmc: MockBmcServer;
	let viewerUrl: string;

	beforeAll(() => {
		bmc = new MockBmcServer({
			width: 320,
			height: 240,
			fillColor: [255, 0, 0],
			sessionCookie: "test-session",
			csrfToken: "test-csrf",
			kvmToken: "test-kvm-token",
			clientIp: "127.0.0.1",
		});
		const baseUrl = bmc.start();
		viewerUrl = `${baseUrl}/viewer`;
	});

	afterEach(() => {
		clearDecoderCache();
	});

	afterAll(() => {
		bmc.stop();
	});

	it("should capture a screenshot and return valid PNG", async () => {
		const result = await captureKvmScreenshot(viewerUrl, {
			connectTimeout: 5000,
			frameTimeout: 5000,
		});

		expect(result.png).toBeInstanceOf(Buffer);
		// PNG magic bytes
		expect(result.png[0]).toBe(0x89);
		expect(result.png[1]).toBe(0x50); // P
		expect(result.png[2]).toBe(0x4e); // N
		expect(result.png[3]).toBe(0x47); // G
	});

	it("should return correct image dimensions", async () => {
		const result = await captureKvmScreenshot(viewerUrl, {
			connectTimeout: 5000,
			frameTimeout: 5000,
		});

		expect(result.width).toBe(320);
		expect(result.height).toBe(240);
	});
});

describe("captureKvmScreenshot error handling", () => {
	it("should throw when BMC session establishment fails", async () => {
		// Start a server that returns a page without any session info
		const badServer = Bun.serve({
			port: 0,
			fetch() {
				return new Response("<html><body>No session here</body></html>", {
					headers: { "Content-Type": "text/html" },
				});
			},
		});

		await expect(
			captureKvmScreenshot(`http://localhost:${badServer.port}/viewer`, {
				connectTimeout: 1000,
				frameTimeout: 1000,
			}),
		).rejects.toThrow("Failed to extract QSESSIONID");

		badServer.stop(true);
	});

	it("should throw when KVM session validation is rejected", async () => {
		const bmc = new MockBmcServer({
			sessionCookie: "reject-session",
			csrfToken: "reject-csrf",
			kvmToken: "reject-token",
			clientIp: "127.0.0.1",
			rejectValidation: true,
		});
		const baseUrl = bmc.start();

		await expect(
			captureKvmScreenshot(`${baseUrl}/viewer`, {
				connectTimeout: 5000,
				frameTimeout: 5000,
			}),
		).rejects.toThrow("KVM session validation failed");

		bmc.stop();
	});
});
