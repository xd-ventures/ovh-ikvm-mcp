import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { captureScreenshot, framebufferToPng } from "../../src/vnc/screenshot.js";
import { TestVncServer } from "../helpers/vnc-server.js";

describe("captureScreenshot", () => {
	let server: TestVncServer;
	let wsUrl: string;

	beforeAll(() => {
		server = new TestVncServer({
			width: 800,
			height: 600,
			fillColor: [0, 128, 255], // blue-ish
		});
		wsUrl = server.start();
	});

	afterAll(() => {
		server.stop();
	});

	it("should return a valid PNG buffer", async () => {
		const result = await captureScreenshot(wsUrl);

		expect(result.png).toBeInstanceOf(Buffer);
		expect(result.width).toBe(800);
		expect(result.height).toBe(600);

		// Verify it's a valid PNG (starts with PNG magic bytes)
		expect(result.png[0]).toBe(0x89);
		expect(result.png[1]).toBe(0x50); // P
		expect(result.png[2]).toBe(0x4e); // N
		expect(result.png[3]).toBe(0x47); // G
	});

	it("should produce a PNG with correct dimensions", async () => {
		const result = await captureScreenshot(wsUrl);
		const png = PNG.sync.read(result.png);

		expect(png.width).toBe(800);
		expect(png.height).toBe(600);
	});

	it("should produce a PNG with correct pixel colors", async () => {
		const result = await captureScreenshot(wsUrl);
		const png = PNG.sync.read(result.png);

		// Check first pixel — should be the fill color (0, 128, 255)
		expect(png.data[0]).toBe(0); // R
		expect(png.data[1]).toBe(128); // G
		expect(png.data[2]).toBe(255); // B
		expect(png.data[3]).toBe(255); // A
	});

	it("should throw for unreachable server", async () => {
		await expect(
			captureScreenshot("ws://localhost:59999", { connectTimeout: 1000 }),
		).rejects.toThrow();
	});
});

describe("framebufferToPng", () => {
	it("should encode a small framebuffer to valid PNG", () => {
		const pixels = new Uint8Array(2 * 2 * 4);
		// 2x2 image: red, green, blue, white
		pixels.set([255, 0, 0, 255], 0); // red
		pixels.set([0, 255, 0, 255], 4); // green
		pixels.set([0, 0, 255, 255], 8); // blue
		pixels.set([255, 255, 255, 255], 12); // white

		const pngBuf = framebufferToPng({ width: 2, height: 2, pixels });

		// Verify PNG magic
		expect(pngBuf[0]).toBe(0x89);
		expect(pngBuf[1]).toBe(0x50);

		// Decode and verify pixels
		const decoded = PNG.sync.read(pngBuf);
		expect(decoded.width).toBe(2);
		expect(decoded.height).toBe(2);
		expect(decoded.data[0]).toBe(255); // red R
		expect(decoded.data[4]).toBe(0); // green R
		expect(decoded.data[5]).toBe(255); // green G
	});
});
