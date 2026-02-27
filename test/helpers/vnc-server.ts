// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Minimal VNC/RFB server for testing.
 * Serves a known test image over WebSocket using the RFB protocol.
 */

import type { ServerWebSocket } from "bun";
import {
	EncodingType,
	PIXEL_FORMAT_RGBA,
	type PixelFormat,
	SecurityType,
} from "../../src/vnc/types.js";

interface WsData {
	state: string;
	serverFormat: PixelFormat;
	challenge?: Uint8Array;
}

type Ws = ServerWebSocket<WsData>;

export interface TestVncServerOptions {
	/** Port to listen on (0 for random) */
	port?: number;
	/** Screen width */
	width?: number;
	/** Screen height */
	height?: number;
	/** Security type */
	security?: "none" | "vnc-auth";
	/** VNC password (only used with vnc-auth) */
	password?: string;
	/** Pixel fill color [R, G, B] — fills the entire screen with this color */
	fillColor?: [number, number, number];
	/** RFB protocol version to advertise */
	rfbVersion?: string;
}

export class TestVncServer {
	private server: ReturnType<typeof Bun.serve<WsData>> | null = null;
	readonly width: number;
	readonly height: number;
	private readonly options: TestVncServerOptions;
	private readonly pixelData: Uint8Array;

	constructor(options: TestVncServerOptions = {}) {
		this.options = options;
		this.width = options.width ?? 800;
		this.height = options.height ?? 600;

		// Generate test pixel data (RGBA)
		const [r, g, b] = options.fillColor ?? [0, 128, 255];
		this.pixelData = new Uint8Array(this.width * this.height * 4);
		for (let i = 0; i < this.width * this.height; i++) {
			this.pixelData[i * 4] = r;
			this.pixelData[i * 4 + 1] = g;
			this.pixelData[i * 4 + 2] = b;
			this.pixelData[i * 4 + 3] = 255;
		}
	}

	/** Start the server and return the WebSocket URL. */
	start(): string {
		const self = this;

		this.server = Bun.serve<WsData>({
			port: this.options.port ?? 0,
			fetch(req, server) {
				if (
					server.upgrade(req, {
						data: { state: "", serverFormat: PIXEL_FORMAT_RGBA },
					})
				) {
					return;
				}
				return new Response("VNC Test Server", { status: 200 });
			},
			websocket: {
				message(ws, message) {
					const buf = message instanceof ArrayBuffer ? message : (message as Uint8Array).buffer;
					self.handleMessage(ws, buf as ArrayBuffer);
				},
				open(ws) {
					self.handleOpen(ws);
				},
			},
		});

		const port = this.server.port;
		return `ws://localhost:${port}`;
	}

	/** Stop the server. */
	stop(): void {
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}

	get port(): number {
		return this.server?.port ?? 0;
	}

	// --- Protocol handling ---

	private handleOpen(ws: Ws): void {
		// Store state on the websocket instance
		ws.data.state = "version";
		ws.data.serverFormat = PIXEL_FORMAT_RGBA;

		// Send RFB version
		const version = this.options.rfbVersion ?? "RFB 003.008\n";
		ws.send(new TextEncoder().encode(version));
	}

	private handleMessage(ws: Ws, message: ArrayBuffer): void {
		const data = new Uint8Array(message);
		const state = ws.data.state as string;

		switch (state) {
			case "version":
				this.handleVersion(ws, data);
				break;
			case "security":
				this.handleSecurityChoice(ws, data);
				break;
			case "vnc-auth":
				this.handleVncAuth(ws, data);
				break;
			case "init":
				this.handleClientInit(ws, data);
				break;
			case "ready":
				this.handleClientMessage(ws, data);
				break;
		}
	}

	private handleVersion(ws: Ws, _data: Uint8Array): void {
		// Client sent version response — send security types
		if (this.options.security === "vnc-auth") {
			ws.send(new Uint8Array([1, SecurityType.VncAuth]));
			ws.data.state = "security";
		} else {
			ws.send(new Uint8Array([1, SecurityType.None]));
			ws.data.state = "security";
		}
	}

	private handleSecurityChoice(ws: Ws, data: Uint8Array): void {
		const chosen = data[0];

		if (chosen === SecurityType.VncAuth) {
			// Send 16-byte challenge
			const challenge = new Uint8Array(16);
			crypto.getRandomValues(challenge);
			ws.data.challenge = challenge;
			ws.send(challenge);
			ws.data.state = "vnc-auth";
		} else {
			// None — send SecurityResult OK
			const result = new Uint8Array(4);
			// All zeros = success
			ws.send(result);
			ws.data.state = "init";
		}
	}

	private handleVncAuth(ws: Ws, _data: Uint8Array): void {
		// For testing, always accept the auth response
		const result = new Uint8Array(4);
		ws.send(result); // success
		ws.data.state = "init";
	}

	private handleClientInit(ws: Ws, _data: Uint8Array): void {
		// Send ServerInit: width(2) + height(2) + pixelFormat(16) + nameLen(4) + name
		const name = "Test VNC Server";
		const nameBytes = new TextEncoder().encode(name);
		const buf = new Uint8Array(24 + nameBytes.length);
		const view = new DataView(buf.buffer);

		view.setUint16(0, this.width);
		view.setUint16(2, this.height);

		// Pixel format (default server format — client may override)
		const pf = PIXEL_FORMAT_RGBA;
		buf[4] = pf.bitsPerPixel;
		buf[5] = pf.depth;
		buf[6] = pf.bigEndian ? 1 : 0;
		buf[7] = pf.trueColor ? 1 : 0;
		view.setUint16(8, pf.redMax);
		view.setUint16(10, pf.greenMax);
		view.setUint16(12, pf.blueMax);
		buf[14] = pf.redShift;
		buf[15] = pf.greenShift;
		buf[16] = pf.blueShift;
		// padding bytes 17-19 are already 0

		view.setUint32(20, nameBytes.length);
		buf.set(nameBytes, 24);

		ws.send(buf);
		ws.data.state = "ready";
	}

	private handleClientMessage(ws: Ws, data: Uint8Array): void {
		if (data.length === 0) return;

		const msgType = data[0];

		// SetPixelFormat (type 0) — 20 bytes total
		if (msgType === 0 && data.length >= 20) {
			// Update server format based on client request
			ws.data.serverFormat = {
				bitsPerPixel: data[4],
				depth: data[5],
				bigEndian: data[6] !== 0,
				trueColor: data[7] !== 0,
				redMax: new DataView(data.buffer, data.byteOffset).getUint16(8),
				greenMax: new DataView(data.buffer, data.byteOffset).getUint16(10),
				blueMax: new DataView(data.buffer, data.byteOffset).getUint16(12),
				redShift: data[14],
				greenShift: data[15],
				blueShift: data[16],
			} as PixelFormat;
			return;
		}

		// SetEncodings (type 2) — 4 + n*4 bytes
		if (msgType === 2) {
			// We only support Raw anyway, just acknowledge
			return;
		}

		// FramebufferUpdateRequest (type 3) — 10 bytes
		if (msgType === 3 && data.length >= 10) {
			const view = new DataView(data.buffer, data.byteOffset);
			const x = view.getUint16(2);
			const y = view.getUint16(4);
			const w = view.getUint16(6);
			const h = view.getUint16(8);

			this.sendFramebufferUpdate(ws, x, y, w, h);
		}
	}

	private sendFramebufferUpdate(ws: Ws, x: number, y: number, w: number, h: number): void {
		const format = ws.data.serverFormat as PixelFormat;
		const bytesPerPixel = format.bitsPerPixel / 8;

		// Extract the requested region from our RGBA pixel data and convert to requested format
		const pixelData = new Uint8Array(w * h * bytesPerPixel);
		for (let row = 0; row < h; row++) {
			for (let col = 0; col < w; col++) {
				const srcIdx = ((y + row) * this.width + (x + col)) * 4;
				const dstIdx = (row * w + col) * bytesPerPixel;
				const r = this.pixelData[srcIdx];
				const g = this.pixelData[srcIdx + 1];
				const b = this.pixelData[srcIdx + 2];

				// Encode pixel in requested format
				const pixel =
					((r & format.redMax) << format.redShift) |
					((g & format.greenMax) << format.greenShift) |
					((b & format.blueMax) << format.blueShift);

				if (bytesPerPixel === 4) {
					if (format.bigEndian) {
						pixelData[dstIdx] = (pixel >>> 24) & 0xff;
						pixelData[dstIdx + 1] = (pixel >>> 16) & 0xff;
						pixelData[dstIdx + 2] = (pixel >>> 8) & 0xff;
						pixelData[dstIdx + 3] = pixel & 0xff;
					} else {
						pixelData[dstIdx] = pixel & 0xff;
						pixelData[dstIdx + 1] = (pixel >>> 8) & 0xff;
						pixelData[dstIdx + 2] = (pixel >>> 16) & 0xff;
						pixelData[dstIdx + 3] = (pixel >>> 24) & 0xff;
					}
				}
			}
		}

		// FramebufferUpdate header: type(1) + padding(1) + numRects(2)
		const header = new Uint8Array(4);
		header[0] = 0; // FramebufferUpdate
		new DataView(header.buffer).setUint16(2, 1); // 1 rectangle

		// Rectangle header: x(2) + y(2) + w(2) + h(2) + encoding(4)
		const rectHeader = new Uint8Array(12);
		const rv = new DataView(rectHeader.buffer);
		rv.setUint16(0, x);
		rv.setUint16(2, y);
		rv.setUint16(4, w);
		rv.setUint16(6, h);
		rv.setInt32(8, EncodingType.Raw);

		// Send all parts
		const full = new Uint8Array(header.length + rectHeader.length + pixelData.length);
		full.set(header, 0);
		full.set(rectHeader, header.length);
		full.set(pixelData, header.length + rectHeader.length);
		ws.send(full);
	}
}
