// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { clearDecoderCache, fetchDecoder } from "../../src/kvm/decoder-fetcher.js";

/**
 * Minimal decoder JS that mimics the AMI AST2500 decoder interface.
 * The real decoder uses `delete` on variables (non-strict JS), so this
 * test fixture also uses `delete` to verify the new Function() loading path.
 */
const VALID_DECODER_JS = `
var temp = 1;
delete temp;

var Decoder = function() {
	this.imageBuffer = null;
	this.m_decodeBuf = null;
};

Decoder.prototype.setImageBuffer = function(imageBuffer) {
	this.imageBuffer = imageBuffer;
	this.m_decodeBuf = imageBuffer.data;
};

Decoder.prototype.decode = function(header, buffer) {
	// no-op for testing
};
`;

describe("fetchDecoder", () => {
	let server: ReturnType<typeof Bun.serve>;
	let host: string;
	let sessionCookie: string;

	beforeAll(() => {
		sessionCookie = "test-decoder-session";

		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);

				if (url.pathname !== "/libs/kvm/ast/decode_worker.js") {
					return new Response("Not Found", { status: 404 });
				}

				// Verify session cookie is sent
				const cookie = req.headers.get("cookie") ?? "";
				if (!cookie.includes(`QSESSIONID=${sessionCookie}`)) {
					return new Response("Unauthorized", { status: 401 });
				}

				return new Response(VALID_DECODER_JS, {
					headers: { "Content-Type": "application/javascript" },
				});
			},
		});

		host = `localhost:${server.port}`;
	});

	afterEach(() => {
		clearDecoderCache();
	});

	afterAll(() => {
		server.stop(true);
	});

	it("should fetch and return a decoder factory function", async () => {
		const factory = await fetchDecoder(host, sessionCookie, "http:");
		expect(typeof factory).toBe("function");
	});

	it("should return a decoder with setImageBuffer and decode methods", async () => {
		const factory = await fetchDecoder(host, sessionCookie, "http:");
		const decoder = factory();
		expect(typeof decoder.setImageBuffer).toBe("function");
		expect(typeof decoder.decode).toBe("function");
	});

	it("should cache the decoder factory per host", async () => {
		const factory1 = await fetchDecoder(host, sessionCookie, "http:");
		const factory2 = await fetchDecoder(host, sessionCookie, "http:");
		expect(factory1).toBe(factory2);
	});

	it("should use separate cache entries for different hosts", async () => {
		// Create a second server on a different port
		const server2 = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/libs/kvm/ast/decode_worker.js") {
					return new Response(VALID_DECODER_JS, {
						headers: { "Content-Type": "application/javascript" },
					});
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			const host2 = `localhost:${server2.port}`;

			const factory1 = await fetchDecoder(host, sessionCookie, "http:");
			const factory2 = await fetchDecoder(host2, "any-cookie", "http:");
			expect(factory1).not.toBe(factory2);
		} finally {
			server2.stop(true);
		}
	});

	it("should clear cache when clearDecoderCache is called", async () => {
		const factory1 = await fetchDecoder(host, sessionCookie, "http:");
		clearDecoderCache();
		const factory2 = await fetchDecoder(host, sessionCookie, "http:");
		expect(factory1).not.toBe(factory2);
	});
});

describe("fetchDecoder error handling", () => {
	afterEach(() => {
		clearDecoderCache();
	});

	it("should throw when the BMC returns a non-200 status", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Internal Server Error", { status: 500 });
			},
		});

		try {
			const host = `localhost:${server.port}`;
			await expect(fetchDecoder(host, "cookie", "http:")).rejects.toThrow(
				/Failed to fetch decoder.*500/,
			);
		} finally {
			server.stop(true);
		}
	});

	it("should throw when the fetched JS is not valid JavaScript", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("this is not {{ valid JS !!!", {
					headers: { "Content-Type": "application/javascript" },
				});
			},
		});

		try {
			const host = `localhost:${server.port}`;
			await expect(fetchDecoder(host, "cookie", "http:")).rejects.toThrow(
				/Failed to initialize decoder/,
			);
		} finally {
			server.stop(true);
		}
	});

	it("should throw when the fetched JS does not define a Decoder constructor", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("var NotADecoder = function() {};", {
					headers: { "Content-Type": "application/javascript" },
				});
			},
		});

		try {
			const host = `localhost:${server.port}`;
			await expect(fetchDecoder(host, "cookie", "http:")).rejects.toThrow(
				/Failed to initialize decoder/,
			);
		} finally {
			server.stop(true);
		}
	});

	it("should throw when the server is unreachable", async () => {
		await expect(fetchDecoder("localhost:1", "cookie", "http:")).rejects.toThrow();
	});
});
