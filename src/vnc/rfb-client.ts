// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Minimal RFB (VNC) protocol client for screenshot capture.
 * Connects via WebSocket, performs handshake, and captures framebuffer.
 */

import { decodeCopyRect, decodeRaw } from "./encodings.js";
import {
	ClientMessageType,
	EncodingType,
	type Framebuffer,
	PIXEL_FORMAT_RGBA,
	type PixelFormat,
	type RfbClientOptions,
	SecurityType,
	type ServerInit,
	ServerMessageType,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_READ_TIMEOUT = 15_000;

export class RfbClient {
	private ws: WebSocket | null = null;
	private serverInit: ServerInit | null = null;
	private framebuffer: Uint8Array | null = null;
	private readonly wsUrl: string;
	private readonly options: RfbClientOptions;

	/** Buffer for accumulating incoming binary data */
	private receiveBuffer: Uint8Array = new Uint8Array(0);
	private receiveResolve: (() => void) | null = null;

	constructor(wsUrl: string, options: RfbClientOptions = {}) {
		this.wsUrl = wsUrl;
		this.options = options;
	}

	/** Connect to the VNC server and complete the RFB handshake. */
	async connect(): Promise<ServerInit> {
		const timeout = this.options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
		await this.wsConnect(timeout);
		return await this.handshake();
	}

	/** Request and receive a full framebuffer update. */
	async capture(): Promise<Framebuffer> {
		if (!this.serverInit) {
			throw new Error("Not connected — call connect() first");
		}

		this.sendSetPixelFormat(PIXEL_FORMAT_RGBA);
		this.sendSetEncodings([EncodingType.Raw, EncodingType.CopyRect]);
		this.sendFramebufferUpdateRequest(false, 0, 0, this.serverInit.width, this.serverInit.height);

		await this.receiveFramebufferUpdate();

		if (!this.framebuffer) {
			throw new Error("Framebuffer not initialized");
		}

		return {
			width: this.serverInit.width,
			height: this.serverInit.height,
			pixels: this.framebuffer,
		};
	}

	/** Disconnect from the server. */
	disconnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	// --- WebSocket connection ---

	private wsConnect(timeout: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Connection timeout after ${timeout}ms`)),
				timeout,
			);

			const ws = new WebSocket(this.wsUrl, ["binary"]);
			ws.binaryType = "arraybuffer";

			ws.addEventListener("open", () => {
				clearTimeout(timer);
				this.ws = ws;
				resolve();
			});

			ws.addEventListener("error", (event) => {
				clearTimeout(timer);
				reject(new Error(`WebSocket error: ${event}`));
			});

			ws.addEventListener("close", () => {
				clearTimeout(timer);
				this.ws = null;
			});

			ws.addEventListener("message", (event) => {
				const data = new Uint8Array(event.data as ArrayBuffer);
				this.appendToBuffer(data);
			});
		});
	}

	private appendToBuffer(data: Uint8Array): void {
		const newBuf = new Uint8Array(this.receiveBuffer.length + data.length);
		newBuf.set(this.receiveBuffer, 0);
		newBuf.set(data, this.receiveBuffer.length);
		this.receiveBuffer = newBuf;

		if (this.receiveResolve) {
			this.receiveResolve();
			this.receiveResolve = null;
		}
	}

	/** Wait until at least `n` bytes are available in the receive buffer. */
	private async waitForBytes(n: number): Promise<void> {
		const timeout = this.options.readTimeout ?? DEFAULT_READ_TIMEOUT;
		const deadline = Date.now() + timeout;

		while (this.receiveBuffer.length < n) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(`Read timeout waiting for ${n} bytes (have ${this.receiveBuffer.length})`);
			}
			await new Promise<void>((resolve, reject) => {
				this.receiveResolve = resolve;
				setTimeout(() => {
					this.receiveResolve = null;
					reject(new Error(`Read timeout waiting for ${n} bytes`));
				}, remaining);
			}).catch((err) => {
				if (this.receiveBuffer.length >= n) return; // Got data in time
				throw err;
			});
		}
	}

	/** Read exactly `n` bytes from the receive buffer. */
	private async readBytes(n: number): Promise<Uint8Array> {
		await this.waitForBytes(n);
		const result = this.receiveBuffer.slice(0, n);
		this.receiveBuffer = this.receiveBuffer.slice(n);
		return result;
	}

	private send(data: Uint8Array | ArrayBuffer): void {
		if (!this.ws) throw new Error("WebSocket not connected");
		this.ws.send(data);
	}

	// --- RFB handshake ---

	private async handshake(): Promise<ServerInit> {
		// 1. Server sends version string (12 bytes: "RFB 003.008\n")
		const versionBytes = await this.readBytes(12);
		const versionStr = new TextDecoder().decode(versionBytes);
		const match = versionStr.match(/^RFB (\d{3})\.(\d{3})\n$/);
		if (!match) {
			throw new Error(`Invalid RFB version string: ${versionStr}`);
		}

		// 2. Client responds with version (we use 3.8 or match server)
		const serverMajor = Number.parseInt(match[1]);
		const serverMinor = Number.parseInt(match[2]);
		let clientVersion: string;
		if (serverMajor === 3 && serverMinor >= 8) {
			clientVersion = "RFB 003.008\n";
		} else if (serverMajor === 3 && serverMinor >= 7) {
			clientVersion = "RFB 003.007\n";
		} else {
			clientVersion = "RFB 003.003\n";
		}
		this.send(new TextEncoder().encode(clientVersion));

		// 3. Security negotiation
		if (serverMajor === 3 && serverMinor >= 7) {
			await this.negotiateSecurity38();
		} else {
			await this.negotiateSecurity33();
		}

		// 4. Client sends ClientInit (shared=true)
		this.send(new Uint8Array([1])); // shared flag

		// 5. Server sends ServerInit
		this.serverInit = await this.readServerInit();

		// Allocate framebuffer
		this.framebuffer = new Uint8Array(this.serverInit.width * this.serverInit.height * 4);

		return this.serverInit;
	}

	private async negotiateSecurity38(): Promise<void> {
		// Server sends number of security types, then the types
		const countBuf = await this.readBytes(1);
		const count = countBuf[0];

		if (count === 0) {
			// Server is sending an error
			const reasonLenBuf = await this.readBytes(4);
			const reasonLen = new DataView(reasonLenBuf.buffer).getUint32(0);
			const reasonBuf = await this.readBytes(reasonLen);
			throw new Error(`Server refused connection: ${new TextDecoder().decode(reasonBuf)}`);
		}

		const typesBuf = await this.readBytes(count);
		const types = Array.from(typesBuf);

		// Prefer None auth, fall back to VncAuth
		if (types.includes(SecurityType.None)) {
			this.send(new Uint8Array([SecurityType.None]));
		} else if (types.includes(SecurityType.VncAuth)) {
			if (!this.options.password) {
				throw new Error("Server requires VNC authentication but no password provided");
			}
			this.send(new Uint8Array([SecurityType.VncAuth]));
			await this.performVncAuth(this.options.password);
		} else {
			throw new Error(`No supported security types: ${types.join(", ")}`);
		}

		// Read SecurityResult
		const resultBuf = await this.readBytes(4);
		const result = new DataView(resultBuf.buffer).getUint32(0);
		if (result !== 0) {
			// Try to read failure reason (RFB 3.8+)
			try {
				const reasonLenBuf = await this.readBytes(4);
				const reasonLen = new DataView(reasonLenBuf.buffer).getUint32(0);
				const reasonBuf = await this.readBytes(reasonLen);
				throw new Error(`Authentication failed: ${new TextDecoder().decode(reasonBuf)}`);
			} catch {
				throw new Error("Authentication failed");
			}
		}
	}

	private async negotiateSecurity33(): Promise<void> {
		// Server sends a single u32 security type
		const typeBuf = await this.readBytes(4);
		const secType = new DataView(typeBuf.buffer).getUint32(0);

		if (secType === 0) {
			const reasonLenBuf = await this.readBytes(4);
			const reasonLen = new DataView(reasonLenBuf.buffer).getUint32(0);
			const reasonBuf = await this.readBytes(reasonLen);
			throw new Error(`Server refused: ${new TextDecoder().decode(reasonBuf)}`);
		}

		if (secType === SecurityType.VncAuth) {
			if (!this.options.password) {
				throw new Error("Server requires VNC authentication but no password provided");
			}
			await this.performVncAuth(this.options.password);
		}
		// SecurityType.None: nothing more to do for 3.3
	}

	private async performVncAuth(password: string): Promise<void> {
		// Server sends 16-byte challenge
		const challenge = await this.readBytes(16);

		// DES-encrypt the challenge with the password
		const response = desEncryptChallenge(challenge, password);
		this.send(response);
	}

	private async readServerInit(): Promise<ServerInit> {
		// width(2) + height(2) + pixel-format(16) + name-length(4)
		const header = await this.readBytes(24);
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

		const width = view.getUint16(0);
		const height = view.getUint16(2);

		const pixelFormat: PixelFormat = {
			bitsPerPixel: header[4],
			depth: header[5],
			bigEndian: header[6] !== 0,
			trueColor: header[7] !== 0,
			redMax: view.getUint16(8),
			greenMax: view.getUint16(10),
			blueMax: view.getUint16(12),
			redShift: header[14],
			greenShift: header[15],
			blueShift: header[16],
		};

		const nameLen = view.getUint32(20);
		const nameBuf = await this.readBytes(nameLen);
		const name = new TextDecoder().decode(nameBuf);

		return { width, height, pixelFormat, name };
	}

	// --- Client messages ---

	private sendSetPixelFormat(pf: PixelFormat): void {
		const buf = new Uint8Array(20);
		const view = new DataView(buf.buffer);

		buf[0] = ClientMessageType.SetPixelFormat;
		// bytes 1-3: padding
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
		// bytes 17-19: padding

		this.send(buf);
	}

	private sendSetEncodings(encodings: number[]): void {
		const buf = new Uint8Array(4 + encodings.length * 4);
		const view = new DataView(buf.buffer);

		buf[0] = ClientMessageType.SetEncodings;
		// byte 1: padding
		view.setUint16(2, encodings.length);
		for (let i = 0; i < encodings.length; i++) {
			view.setInt32(4 + i * 4, encodings[i]);
		}

		this.send(buf);
	}

	private sendFramebufferUpdateRequest(
		incremental: boolean,
		x: number,
		y: number,
		width: number,
		height: number,
	): void {
		const buf = new Uint8Array(10);
		const view = new DataView(buf.buffer);

		buf[0] = ClientMessageType.FramebufferUpdateRequest;
		buf[1] = incremental ? 1 : 0;
		view.setUint16(2, x);
		view.setUint16(4, y);
		view.setUint16(6, width);
		view.setUint16(8, height);

		this.send(buf);
	}

	// --- Receive framebuffer update ---

	private async receiveFramebufferUpdate(): Promise<void> {
		const timeout = this.options.readTimeout ?? DEFAULT_READ_TIMEOUT;
		const deadline = Date.now() + timeout;

		// Wait for a FramebufferUpdate message
		while (true) {
			if (Date.now() > deadline) {
				throw new Error("Timeout waiting for framebuffer update");
			}

			const msgType = await this.readBytes(1);

			if (msgType[0] === ServerMessageType.FramebufferUpdate) {
				// padding(1) + numRects(2)
				const header = await this.readBytes(3);
				const numRects = new DataView(
					header.buffer,
					header.byteOffset,
					header.byteLength,
				).getUint16(1);

				for (let i = 0; i < numRects; i++) {
					await this.receiveRect();
				}
				return;
			}

			if (msgType[0] === ServerMessageType.SetColourMapEntries) {
				await this.skipSetColourMap();
			} else if (msgType[0] === ServerMessageType.Bell) {
				// No data to read
			} else if (msgType[0] === ServerMessageType.ServerCutText) {
				await this.skipServerCutText();
			} else {
				throw new Error(`Unexpected server message type: ${msgType[0]}`);
			}
		}
	}

	private async receiveRect(): Promise<void> {
		if (!this.serverInit || !this.framebuffer) {
			throw new Error("Not initialized");
		}

		// x(2) + y(2) + width(2) + height(2) + encoding(4) = 12 bytes
		const header = await this.readBytes(12);
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

		const x = view.getUint16(0);
		const y = view.getUint16(2);
		const width = view.getUint16(4);
		const height = view.getUint16(6);
		const encoding = view.getInt32(8);

		if (encoding === EncodingType.Raw) {
			const bytesPerPixel = 4; // We requested RGBA (32bpp)
			const dataLen = width * height * bytesPerPixel;
			const data = await this.readBytes(dataLen);

			const rect = { x, y, width, height, encoding, data };
			const rgba = decodeRaw(rect, PIXEL_FORMAT_RGBA);

			// Blit into framebuffer
			for (let row = 0; row < height; row++) {
				const srcOffset = row * width * 4;
				const dstOffset = ((y + row) * this.serverInit.width + x) * 4;
				this.framebuffer.set(rgba.slice(srcOffset, srcOffset + width * 4), dstOffset);
			}
		} else if (encoding === EncodingType.CopyRect) {
			const data = await this.readBytes(4);
			decodeCopyRect(
				{ x, y, width, height, encoding, data },
				this.framebuffer,
				this.serverInit.width,
			);
		} else {
			throw new Error(`Unsupported encoding: ${encoding}`);
		}
	}

	private async skipSetColourMap(): Promise<void> {
		// padding(1) + firstColour(2) + numColours(2)
		const header = await this.readBytes(5);
		const numColours = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(
			3,
		);
		// Each colour: r(2) + g(2) + b(2) = 6 bytes
		await this.readBytes(numColours * 6);
	}

	private async skipServerCutText(): Promise<void> {
		// padding(3) + length(4)
		const header = await this.readBytes(7);
		const len = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(3);
		await this.readBytes(len);
	}
}

// --- DES encryption for VNC authentication ---

/**
 * VNC auth uses a modified DES where each byte of the key has its bits reversed.
 * The password is truncated/padded to 8 bytes, then used to DES-ECB encrypt the challenge.
 */
function desEncryptChallenge(challenge: Uint8Array, password: string): Uint8Array {
	// Prepare 8-byte key from password (truncate or pad with zeros)
	const key = new Uint8Array(8);
	for (let i = 0; i < 8 && i < password.length; i++) {
		key[i] = reverseBits(password.charCodeAt(i));
	}

	// DES-ECB encrypt two 8-byte blocks of the challenge
	const result = new Uint8Array(16);
	const des = new DesEcb(key);
	des.encrypt(challenge.slice(0, 8), result.subarray(0, 8));
	des.encrypt(challenge.slice(8, 16), result.subarray(8, 16));

	return result;
}

function reverseBits(input: number): number {
	let b = input;
	let result = 0;
	for (let i = 0; i < 8; i++) {
		result = (result << 1) | (b & 1);
		b >>= 1;
	}
	return result;
}

/**
 * Minimal DES-ECB implementation for VNC authentication.
 * This is a direct port of the standard DES algorithm.
 */
class DesEcb {
	private readonly keys: Uint32Array;

	constructor(key: Uint8Array) {
		this.keys = this.generateKeys(key);
	}

	encrypt(input: Uint8Array, output: Uint8Array): void {
		let l = 0;
		let r = 0;

		// Initial permutation
		for (let i = 0; i < 4; i++) {
			l = (l << 8) | input[i];
			r = (r << 8) | input[i + 4];
		}
		let t: number;
		t = ((l >>> 4) ^ r) & 0x0f0f0f0f;
		r ^= t;
		l ^= t << 4;
		t = ((l >>> 16) ^ r) & 0x0000ffff;
		r ^= t;
		l ^= t << 16;
		t = ((r >>> 2) ^ l) & 0x33333333;
		l ^= t;
		r ^= t << 2;
		t = ((r >>> 8) ^ l) & 0x00ff00ff;
		l ^= t;
		r ^= t << 8;
		t = ((l >>> 1) ^ r) & 0x55555555;
		r ^= t;
		l ^= t << 1;

		// Rotate
		l = ((l << 1) | (l >>> 31)) >>> 0;
		r = ((r << 1) | (r >>> 31)) >>> 0;

		// 16 rounds
		for (let i = 0; i < 16; i++) {
			const k1 = this.keys[i * 2];
			const k2 = this.keys[i * 2 + 1];

			let f = ((r >>> 0) ^ k1) >>> 0;
			const rr = ((r << 28) | (r >>> 4)) >>> 0;
			f =
				(SP1[(f >>> 24) & 0x3f] |
					SP3[(f >>> 16) & 0x3f] |
					SP5[(f >>> 8) & 0x3f] |
					SP7[f & 0x3f]) >>>
				0;
			const g = (rr ^ k2) >>> 0;
			f =
				(f |
					SP2[(g >>> 24) & 0x3f] |
					SP4[(g >>> 16) & 0x3f] |
					SP6[(g >>> 8) & 0x3f] |
					SP8[g & 0x3f]) >>>
				0;

			t = l;
			l = r;
			r = (t ^ f) >>> 0;
		}

		// Undo rotate
		l = ((l >>> 1) | (l << 31)) >>> 0;
		r = ((r >>> 1) | (r << 31)) >>> 0;

		// Final permutation (inverse of initial)
		t = ((l >>> 1) ^ r) & 0x55555555;
		r ^= t;
		l ^= t << 1;
		t = ((r >>> 8) ^ l) & 0x00ff00ff;
		l ^= t;
		r ^= t << 8;
		t = ((r >>> 2) ^ l) & 0x33333333;
		l ^= t;
		r ^= t << 2;
		t = ((l >>> 16) ^ r) & 0x0000ffff;
		r ^= t;
		l ^= t << 16;
		t = ((l >>> 4) ^ r) & 0x0f0f0f0f;
		r ^= t;
		l ^= t << 4;

		for (let i = 0; i < 4; i++) {
			output[i] = (r >>> (24 - i * 8)) & 0xff;
			output[i + 4] = (l >>> (24 - i * 8)) & 0xff;
		}
	}

	private generateKeys(key: Uint8Array): Uint32Array {
		const keys = new Uint32Array(32);

		let c = 0;
		let d = 0;

		// PC1 permutation
		for (let i = 0; i < 28; i++) {
			const bit = PC1C[i];
			if (key[bit >>> 3] & (128 >>> (bit & 7))) c |= 1 << (27 - i);
		}
		for (let i = 0; i < 28; i++) {
			const bit = PC1D[i];
			if (key[bit >>> 3] & (128 >>> (bit & 7))) d |= 1 << (27 - i);
		}

		for (let i = 0; i < 16; i++) {
			const shifts = SHIFTS[i];
			c = ((c << shifts) | (c >>> (28 - shifts))) & 0x0fffffff;
			d = ((d << shifts) | (d >>> (28 - shifts))) & 0x0fffffff;

			// PC2 permutation
			let k1 = 0;
			let k2 = 0;
			for (let j = 0; j < 24; j++) {
				const bit1 = PC2[j];
				if (bit1 < 28) {
					if (c & (1 << (27 - bit1))) k1 |= 1 << (23 - j);
				} else {
					if (d & (1 << (27 - (bit1 - 28)))) k1 |= 1 << (23 - j);
				}
				const bit2 = PC2[j + 24];
				if (bit2 < 28) {
					if (c & (1 << (27 - bit2))) k2 |= 1 << (23 - j);
				} else {
					if (d & (1 << (27 - (bit2 - 28)))) k2 |= 1 << (23 - j);
				}
			}
			keys[i * 2] = k1;
			keys[i * 2 + 1] = k2;
		}

		return keys;
	}
}

// DES tables
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const PC1C = [
	7, 15, 23, 31, 39, 47, 55, 63, 6, 14, 22, 30, 38, 46, 54, 62, 5, 13, 21, 29, 37, 45, 53, 61, 4,
	12, 20, 28,
];
const PC1D = [
	1, 9, 17, 25, 33, 41, 49, 57, 2, 10, 18, 26, 34, 42, 50, 58, 3, 11, 19, 27, 35, 43, 51, 59, 36,
	44, 52, 60,
];
const PC2 = [
	13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30,
	36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
];

const SP1 = new Uint32Array([
	0x01010400, 0x00000000, 0x00010000, 0x01010404, 0x01010004, 0x00010404, 0x00000004, 0x00010000,
	0x00000400, 0x01010400, 0x01010404, 0x00000400, 0x01000404, 0x01010004, 0x01000000, 0x00000004,
	0x00000404, 0x01000400, 0x01000400, 0x00010400, 0x00010400, 0x01010000, 0x01010000, 0x01000404,
	0x00010004, 0x01000004, 0x01000004, 0x00010004, 0x00000000, 0x00000404, 0x00010404, 0x01000000,
	0x00010000, 0x01010404, 0x00000004, 0x01010000, 0x01010400, 0x01000000, 0x01000000, 0x00000400,
	0x01010004, 0x00010000, 0x00010400, 0x01000004, 0x00000400, 0x00000004, 0x01000404, 0x00010404,
	0x01010404, 0x00010004, 0x01010000, 0x01000404, 0x01000004, 0x00000404, 0x00010404, 0x01010400,
	0x00000404, 0x01000400, 0x01000400, 0x00000000, 0x00010004, 0x00010400, 0x00000000, 0x01010004,
]);
const SP2 = new Uint32Array([
	0x80108020, 0x80008000, 0x00008000, 0x00108020, 0x00100000, 0x00000020, 0x80100020, 0x80008020,
	0x80000020, 0x80108020, 0x80108000, 0x80000000, 0x80008000, 0x00100000, 0x00000020, 0x80100020,
	0x00108000, 0x00100020, 0x80008020, 0x00000000, 0x80000000, 0x00008000, 0x00108020, 0x80100000,
	0x00100020, 0x80000020, 0x00000000, 0x00108000, 0x00008020, 0x80108000, 0x80100000, 0x00008020,
	0x00000000, 0x00108020, 0x80100020, 0x00100000, 0x80008020, 0x80100000, 0x80108000, 0x00008000,
	0x80100000, 0x80008000, 0x00000020, 0x80108020, 0x00108020, 0x00000020, 0x00008000, 0x80000000,
	0x00008020, 0x80108000, 0x00100000, 0x80000020, 0x00100020, 0x80008020, 0x80000020, 0x00100020,
	0x00108000, 0x00000000, 0x80008000, 0x00008020, 0x80000000, 0x80100020, 0x80108020, 0x00108000,
]);
const SP3 = new Uint32Array([
	0x00000208, 0x08020200, 0x00000000, 0x08020008, 0x08000200, 0x00000000, 0x00020208, 0x08000200,
	0x00020008, 0x08000008, 0x08000008, 0x00020000, 0x08020208, 0x00020008, 0x08020000, 0x00000208,
	0x08000000, 0x00000008, 0x08020200, 0x00000200, 0x00020200, 0x08020000, 0x08020008, 0x00020208,
	0x08000208, 0x00020200, 0x00020000, 0x08000208, 0x00000008, 0x08020208, 0x00000200, 0x08000000,
	0x08020200, 0x08000000, 0x00020008, 0x00000208, 0x00020000, 0x08020200, 0x08000200, 0x00000000,
	0x00000200, 0x00020008, 0x08020208, 0x08000200, 0x08000008, 0x00000200, 0x00000000, 0x08020008,
	0x08000208, 0x00020000, 0x08000000, 0x08020208, 0x00000008, 0x00020208, 0x00020200, 0x08000008,
	0x08020000, 0x08000208, 0x00000208, 0x08020000, 0x00020208, 0x00000008, 0x08020008, 0x00020200,
]);
const SP4 = new Uint32Array([
	0x00802001, 0x00002081, 0x00002081, 0x00000080, 0x00802080, 0x00800081, 0x00800001, 0x00002001,
	0x00000000, 0x00802000, 0x00802000, 0x00802081, 0x00000081, 0x00000000, 0x00800080, 0x00800001,
	0x00000001, 0x00002000, 0x00800000, 0x00802001, 0x00000080, 0x00800000, 0x00002001, 0x00002080,
	0x00800081, 0x00000001, 0x00002080, 0x00800080, 0x00002000, 0x00802080, 0x00802081, 0x00000081,
	0x00800080, 0x00800001, 0x00802000, 0x00802081, 0x00000081, 0x00000000, 0x00000000, 0x00802000,
	0x00002080, 0x00800080, 0x00800081, 0x00000001, 0x00802001, 0x00002081, 0x00002081, 0x00000080,
	0x00802081, 0x00000081, 0x00000001, 0x00002000, 0x00800001, 0x00002001, 0x00802080, 0x00800081,
	0x00002001, 0x00002080, 0x00800000, 0x00802001, 0x00000080, 0x00800000, 0x00002000, 0x00802080,
]);
const SP5 = new Uint32Array([
	0x00000100, 0x02080100, 0x02080000, 0x42000100, 0x00080000, 0x00000100, 0x40000000, 0x02080000,
	0x40080100, 0x00080000, 0x02000100, 0x40080100, 0x42000100, 0x42080000, 0x00080100, 0x40000000,
	0x02000000, 0x40080000, 0x40080000, 0x00000000, 0x40000100, 0x42080100, 0x42080100, 0x02000100,
	0x42080000, 0x40000100, 0x00000000, 0x42000000, 0x02080100, 0x02000000, 0x42000000, 0x00080100,
	0x00080000, 0x42000100, 0x00000100, 0x02000000, 0x40000000, 0x02080000, 0x42000100, 0x40080100,
	0x02000100, 0x40000000, 0x42080000, 0x02080100, 0x40080100, 0x00000100, 0x02000000, 0x42080000,
	0x42080100, 0x00080100, 0x42000000, 0x42080100, 0x02080000, 0x00000000, 0x40080000, 0x42000000,
	0x00080100, 0x02000100, 0x40000100, 0x00080000, 0x00000000, 0x40080000, 0x02080100, 0x40000100,
]);
const SP6 = new Uint32Array([
	0x20000010, 0x20400000, 0x00004000, 0x20404010, 0x20400000, 0x00000010, 0x20404010, 0x00400000,
	0x20004000, 0x00404010, 0x00400000, 0x20000010, 0x00400010, 0x20004000, 0x20000000, 0x00004010,
	0x00000000, 0x00400010, 0x20004010, 0x00004000, 0x00404000, 0x20004010, 0x00000010, 0x20400010,
	0x20400010, 0x00000000, 0x00404010, 0x20404000, 0x00004010, 0x00404000, 0x20404000, 0x20000000,
	0x20004000, 0x00000010, 0x20400010, 0x00404000, 0x20404010, 0x00400000, 0x00004010, 0x20000010,
	0x00400000, 0x20004000, 0x20000000, 0x00004010, 0x20000010, 0x20404010, 0x00404000, 0x20400000,
	0x00404010, 0x20404000, 0x00000000, 0x20400010, 0x00000010, 0x00004000, 0x20400000, 0x00404010,
	0x00004000, 0x00400010, 0x20004010, 0x00000000, 0x20404000, 0x20000000, 0x00400010, 0x20004010,
]);
const SP7 = new Uint32Array([
	0x00200000, 0x04200002, 0x04000802, 0x00000000, 0x00000800, 0x04000802, 0x00200802, 0x04200800,
	0x04200802, 0x00200000, 0x00000000, 0x04000002, 0x00000002, 0x04000000, 0x04200002, 0x00000802,
	0x04000800, 0x00200802, 0x00200002, 0x04000800, 0x04000002, 0x04200000, 0x04200800, 0x00200002,
	0x04200000, 0x00000800, 0x00000802, 0x04200802, 0x00200800, 0x00000002, 0x04000000, 0x00200800,
	0x04000000, 0x00200800, 0x00200000, 0x04000802, 0x04000802, 0x04200002, 0x04200002, 0x00000002,
	0x00200002, 0x04000000, 0x04000800, 0x00200000, 0x04200800, 0x00000802, 0x00200802, 0x04200800,
	0x00000802, 0x04000002, 0x04200802, 0x04200000, 0x00200800, 0x00000000, 0x00000002, 0x04200802,
	0x00000000, 0x00200802, 0x04200000, 0x00000800, 0x04000002, 0x04000800, 0x00000800, 0x00200002,
]);
const SP8 = new Uint32Array([
	0x10001040, 0x00001000, 0x00040000, 0x10041040, 0x10000000, 0x10001040, 0x00000040, 0x10000000,
	0x00040040, 0x10040000, 0x10041040, 0x00041000, 0x10041000, 0x00041040, 0x00001000, 0x00000040,
	0x10040000, 0x10000040, 0x10001000, 0x00001040, 0x00041000, 0x00040040, 0x10040040, 0x10041000,
	0x00001040, 0x00000000, 0x00000000, 0x10040040, 0x10000040, 0x10001000, 0x00041040, 0x00040000,
	0x00041040, 0x00040000, 0x10041000, 0x00001000, 0x00000040, 0x10040040, 0x00001000, 0x00041040,
	0x10001000, 0x00000040, 0x10000040, 0x10040000, 0x10040040, 0x10000000, 0x00040000, 0x10001040,
	0x00000000, 0x10041040, 0x00040040, 0x10000040, 0x10040000, 0x10001000, 0x10001040, 0x00000000,
	0x10041040, 0x00041000, 0x00041000, 0x00001040, 0x00001040, 0x00040040, 0x10000000, 0x10041000,
]);
