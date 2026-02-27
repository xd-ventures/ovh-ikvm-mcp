// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Mock ASRockRack/AMI BMC server for testing.
 *
 * Simulates:
 * 1. HTTP redirect page with QSESSIONID cookie and garc CSRF token
 * 2. /viewer.html endpoint (session activation)
 * 3. /api/kvm/token endpoint (returns KVM auth token)
 * 4. /libs/kvm/ast/decode_worker.js endpoint (AST2500 decoder JS)
 * 5. WebSocket at /kvm with IVTP protocol handshake and AST2500 video frame delivery
 */

import type { Server as BunServerType, ServerWebSocket } from "bun";

type BunServer = BunServerType<undefined>;

/** IVTP constants matching the real AMI firmware. */
const IVTP = {
	HDR_SIZE: 8,
	VIDEO_PACKET_SIZE: 373,
	CMD_RESUME_REDIRECTION: 0x06,
	CMD_GET_FULL_SCREEN: 0x0b,
	CMD_VALIDATE_VIDEO_SESSION: 0x12,
	CMD_VALIDATED_VIDEO_SESSION: 0x13,
	CMD_CONNECTION_ALLOWED: 0x17,
	CMD_VIDEO_PACKETS: 0x19,
	CMD_POWER_STATUS: 0x22,
	CMD_CONNECTION_COMPLETE_PKT: 0x3a,
} as const;

export interface MockBmcServerOptions {
	port?: number;
	/** Session cookie value to set */
	sessionCookie?: string;
	/** CSRF token to embed in page */
	csrfToken?: string;
	/** KVM token returned by /api/kvm/token */
	kvmToken?: string;
	/** Client IP returned by /api/kvm/token */
	clientIp?: string;
	/** Test image dimensions */
	width?: number;
	height?: number;
	/** Fill color [R, G, B] for the test image */
	fillColor?: [number, number, number];
	/** Delay before sending video frame (ms) */
	frameDelay?: number;
	/** If true, embed cookie in JS instead of Set-Cookie header */
	cookieInJs?: boolean;
	/** If true, reject KVM session validation */
	rejectValidation?: boolean;
}

export class MockBmcServer {
	private server: BunServer | null = null;
	private readonly options: MockBmcServerOptions;
	readonly width: number;
	readonly height: number;

	constructor(options: MockBmcServerOptions = {}) {
		this.options = options;
		this.width = options.width ?? 320;
		this.height = options.height ?? 240;
	}

	start(): string {
		const self = this;

		this.server = Bun.serve({
			port: this.options.port ?? 0,
			fetch(req, server) {
				return self.handleRequest(req, server);
			},
			websocket: {
				message(ws: ServerWebSocket, message: string | Buffer) {
					self.handleWsMessage(ws, message);
				},
				open(ws: ServerWebSocket) {
					self.handleWsOpen(ws);
				},
			},
		});

		return `http://localhost:${this.server.port}`;
	}

	stop(): void {
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}

	get port(): number {
		return this.server?.port ?? 0;
	}

	get baseUrl(): string {
		return `http://localhost:${this.port}`;
	}

	private handleRequest(req: Request, server: BunServerType<undefined>): Response | undefined {
		const url = new URL(req.url);

		if (url.pathname === "/kvm") {
			if (server.upgrade(req)) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		if (url.pathname === "/viewer" || url.pathname === "/") {
			return this.serveRedirectPage();
		}

		if (url.pathname === "/viewer.html") {
			return new Response("<html><body>KVM Viewer</body></html>", {
				headers: { "Content-Type": "text/html" },
			});
		}

		if (url.pathname === "/api/kvm/token") {
			return this.serveKvmToken(req);
		}

		if (url.pathname === "/libs/kvm/ast/decode_worker.js") {
			return this.serveDecoderJs(req);
		}

		return new Response("Not Found", { status: 404 });
	}

	private serveRedirectPage(): Response {
		const cookie = this.options.sessionCookie ?? "test-session-id-12345";
		const csrf = this.options.csrfToken ?? "test-csrf-token-abc";
		const cookieInJs = this.options.cookieInJs ?? false;

		const html = `<!DOCTYPE html>
<html>
<head><title>Redirect</title></head>
<body>
<script>
${cookieInJs ? `document.cookie = "QSESSIONID=${cookie}";` : "// QSESSIONID set via header"}
var garc_token = ["garc", "${csrf}"];
window.location.href = "/viewer.html";
</script>
</body>
</html>`;

		const headers: Record<string, string> = { "Content-Type": "text/html" };
		if (!cookieInJs) {
			headers["Set-Cookie"] = `QSESSIONID=${cookie}; Path=/; HttpOnly`;
		}
		return new Response(html, { headers });
	}

	private serveKvmToken(req: Request): Response {
		const cookieHeader = req.headers.get("cookie") ?? "";
		const expectedCookie = this.options.sessionCookie ?? "test-session-id-12345";
		if (!cookieHeader.includes(`QSESSIONID=${expectedCookie}`)) {
			return new Response("Unauthorized", { status: 401 });
		}
		return Response.json({
			client_ip: this.options.clientIp ?? "127.0.0.1",
			token: this.options.kvmToken ?? "mock-kvm-token-xyz",
			session: "mock-session-id",
		});
	}

	private serveDecoderJs(req: Request): Response {
		const cookieHeader = req.headers.get("cookie") ?? "";
		const expectedCookie = this.options.sessionCookie ?? "test-session-id-12345";
		if (!cookieHeader.includes(`QSESSIONID=${expectedCookie}`)) {
			return new Response("Unauthorized", { status: 401 });
		}
		return new Response(MOCK_DECODER_JS, {
			headers: { "Content-Type": "application/javascript" },
		});
	}

	private handleWsOpen(ws: ServerWebSocket): void {
		const buf = new ArrayBuffer(IVTP.HDR_SIZE);
		const view = new DataView(buf);
		view.setUint16(0, IVTP.CMD_CONNECTION_ALLOWED, true);
		view.setUint32(2, 0, true);
		view.setUint16(6, 0, true);
		ws.send(buf);
	}

	private handleWsMessage(ws: ServerWebSocket, message: string | Buffer): void {
		const data = message instanceof Buffer ? message : Buffer.from(message);
		let offset = 0;

		while (offset + IVTP.HDR_SIZE <= data.length) {
			const view = new DataView(data.buffer, data.byteOffset + offset, IVTP.HDR_SIZE);
			const type = view.getUint16(0, true);
			const pktsize = view.getUint32(2, true);
			offset += IVTP.HDR_SIZE + pktsize;

			switch (type) {
				case IVTP.CMD_CONNECTION_COMPLETE_PKT:
					break;
				case IVTP.CMD_VALIDATE_VIDEO_SESSION:
					this.sendValidationResponse(ws);
					break;
				case IVTP.CMD_RESUME_REDIRECTION:
					break;
				case IVTP.CMD_POWER_STATUS:
					this.sendPowerStatus(ws);
					break;
				case IVTP.CMD_GET_FULL_SCREEN:
					this.sendVideoFrame(ws);
					break;
				default:
					break;
			}
		}
	}

	private sendValidationResponse(ws: ServerWebSocket): void {
		const reject = this.options.rejectValidation ?? false;
		const buf = new ArrayBuffer(IVTP.HDR_SIZE + 2);
		const view = new DataView(buf);
		view.setUint16(0, IVTP.CMD_VALIDATED_VIDEO_SESSION, true);
		view.setUint32(2, 2, true);
		view.setUint16(6, 0, true);
		view.setUint8(8, reject ? 0 : 1);
		view.setUint8(9, 0);
		ws.send(buf);
	}

	private sendPowerStatus(ws: ServerWebSocket): void {
		const buf = new ArrayBuffer(IVTP.HDR_SIZE);
		const view = new DataView(buf);
		view.setUint16(0, IVTP.CMD_POWER_STATUS, true);
		view.setUint32(2, 0, true);
		view.setUint16(6, 1, true);
		ws.send(buf);
	}

	private sendVideoFrame(ws: ServerWebSocket): void {
		const delay = this.options.frameDelay ?? 10;

		setTimeout(() => {
			// Build an AST2500-format video frame
			const videoPacket = this.buildAst2500VideoPacket();

			// Wrap in CMD_VIDEO_PACKETS IVTP message
			const buf = new ArrayBuffer(IVTP.HDR_SIZE + videoPacket.length);
			const view = new DataView(buf);
			view.setUint16(0, IVTP.CMD_VIDEO_PACKETS, true);
			view.setUint32(2, videoPacket.length, true);
			view.setUint16(6, 0, true);
			new Uint8Array(buf, IVTP.HDR_SIZE).set(videoPacket);
			ws.send(buf);
		}, delay);
	}

	/**
	 * Build a minimal AST2500-format video packet:
	 * fragment(2) + header(86) + compressed_data(8)
	 *
	 * The compressed data is a single FRAME_END tile code (0x09 in top 4 bits),
	 * which tells the decoder "no tiles to update" — producing a black image.
	 * This is sufficient for testing the full pipeline.
	 */
	private buildAst2500VideoPacket(): Uint8Array {
		const { width, height } = this;
		const HEADER_LEN = 86;
		const COMPRESSED_SIZE = 8; // 2 x Int32 minimum for bit reader init
		const FRAG_SIZE = 2;
		const totalSize = FRAG_SIZE + HEADER_LEN + COMPRESSED_SIZE;

		const packet = new Uint8Array(totalSize);
		const dv = new DataView(packet.buffer);

		// Fragment number (2 bytes)
		dv.setUint16(0, 0, true);

		// AST2500 video engine header (86 bytes at offset 2)
		const hdrOff = FRAG_SIZE;
		dv.setUint16(hdrOff + 0, 1, true); // iEngineVersion
		dv.setUint16(hdrOff + 2, HEADER_LEN, true); // wHeaderLen
		dv.setUint16(hdrOff + 4, width, true); // SourceModeInfo.X
		dv.setUint16(hdrOff + 6, height, true); // SourceModeInfo.Y
		// SourceModeInfo.ColorDepth, RefreshRate, ModeIndex: zeros
		dv.setUint16(hdrOff + 13, width, true); // DestinationModeInfo.X
		dv.setUint16(hdrOff + 15, height, true); // DestinationModeInfo.Y
		// Other DestinationModeInfo fields: zeros
		dv.setUint8(hdrOff + 42, 3); // CompressionMode
		dv.setUint8(hdrOff + 43, 16); // JPEGScaleFactor
		dv.setUint8(hdrOff + 44, 4); // JPEGTableSelector
		dv.setUint8(hdrOff + 45, 0); // JPEGYUVTableMapping
		dv.setUint8(hdrOff + 47, 7); // AdvanceTableSelector
		const numMB = Math.ceil(width / 8) * Math.ceil(height / 8);
		dv.setUint32(hdrOff + 49, numMB, true); // NumberOfMB
		dv.setUint8(hdrOff + 53, 0); // RC4Enable
		dv.setUint8(hdrOff + 55, 0); // Mode420 (YUV444)
		dv.setUint32(hdrOff + 69, COMPRESSED_SIZE, true); // CompressData.CompressSize

		// Compressed data (8 bytes at offset 88)
		// FRAME_END code = 0x09 in top 4 bits of first Int32.
		// On little-endian, Int32 value 0x90000000 is stored as bytes: 00 00 00 90
		const dataOff = FRAG_SIZE + HEADER_LEN;
		dv.setInt32(dataOff, 0x90000000, false); // big-endian write = native Int32 0x90000000
		// Wait, no. The decoder reads m_RecvBuffer[0] as native Int32.
		// new Int32Array(buffer)[0] on LE platform reads bytes [0..3] as LE int32.
		// We want Int32Array[0] = 0x90000000
		// In LE bytes: 00 00 00 90
		dv.setInt32(dataOff, -1879048192, true); // 0x90000000 as signed int32 in LE
		dv.setInt32(dataOff + 4, 0, true); // nextData = 0

		return packet;
	}
}

/**
 * Minimal mock decoder JS that mimics the AMI AST2500 decoder interface.
 *
 * Uses `delete` on a variable to test non-strict mode compatibility
 * (the real decoder does this). The decode() method is a no-op that
 * produces a black image — sufficient for testing the full pipeline.
 */
const MOCK_DECODER_JS = `
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
	// No-op: produces a black image (all zeros in the image buffer)
};
`;
