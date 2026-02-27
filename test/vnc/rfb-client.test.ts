// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RfbClient } from "../../src/vnc/rfb-client.js";
import { TestVncServer } from "../helpers/vnc-server.js";

describe("RfbClient", () => {
	let server: TestVncServer;
	let wsUrl: string;

	beforeAll(() => {
		server = new TestVncServer({
			width: 320,
			height: 240,
			fillColor: [255, 0, 0], // red
		});
		wsUrl = server.start();
	});

	afterAll(() => {
		server.stop();
	});

	it("should connect and complete RFB handshake", async () => {
		const client = new RfbClient(wsUrl);
		const serverInit = await client.connect();

		expect(serverInit.width).toBe(320);
		expect(serverInit.height).toBe(240);
		expect(serverInit.name).toBe("Test VNC Server");
		expect(serverInit.pixelFormat.bitsPerPixel).toBe(32);
		expect(serverInit.pixelFormat.trueColor).toBe(true);

		client.disconnect();
	});

	it("should capture framebuffer with correct dimensions", async () => {
		const client = new RfbClient(wsUrl);
		await client.connect();
		const fb = await client.capture();

		expect(fb.width).toBe(320);
		expect(fb.height).toBe(240);
		expect(fb.pixels.length).toBe(320 * 240 * 4);

		client.disconnect();
	});

	it("should capture correct pixel colors", async () => {
		const client = new RfbClient(wsUrl);
		await client.connect();
		const fb = await client.capture();

		// Check first pixel — should be red (255, 0, 0, 255)
		expect(fb.pixels[0]).toBe(255); // R
		expect(fb.pixels[1]).toBe(0); // G
		expect(fb.pixels[2]).toBe(0); // B
		expect(fb.pixels[3]).toBe(255); // A

		// Check a pixel in the middle
		const mid = (120 * 320 + 160) * 4;
		expect(fb.pixels[mid]).toBe(255);
		expect(fb.pixels[mid + 1]).toBe(0);
		expect(fb.pixels[mid + 2]).toBe(0);

		client.disconnect();
	});

	it("should throw on connection timeout to non-existent server", async () => {
		const client = new RfbClient("ws://localhost:59999", {
			connectTimeout: 1000,
		});

		await expect(client.connect()).rejects.toThrow();
	});
});

describe("RfbClient with VNC auth", () => {
	let server: TestVncServer;
	let wsUrl: string;

	beforeAll(() => {
		server = new TestVncServer({
			width: 100,
			height: 100,
			security: "vnc-auth",
			password: "testpass",
			fillColor: [0, 255, 0], // green
		});
		wsUrl = server.start();
	});

	afterAll(() => {
		server.stop();
	});

	it("should authenticate with password and capture", async () => {
		const client = new RfbClient(wsUrl, { password: "testpass" });
		await client.connect();
		const fb = await client.capture();

		expect(fb.width).toBe(100);
		expect(fb.height).toBe(100);
		// Green pixel
		expect(fb.pixels[0]).toBe(0);
		expect(fb.pixels[1]).toBe(255);
		expect(fb.pixels[2]).toBe(0);

		client.disconnect();
	});

	it("should throw when no password provided for auth server", async () => {
		const client = new RfbClient(wsUrl);

		await expect(client.connect()).rejects.toThrow(
			"Server requires VNC authentication but no password provided",
		);
	});
});
