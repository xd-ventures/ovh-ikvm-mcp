/**
 * KVM screenshot capture via AMI/ASRockRack WebSocket protocol.
 *
 * Connects to the BMC's KVM WebSocket, receives binary frames,
 * scans for JPEG SOI/EOI markers, extracts the JPEG image,
 * and converts it to PNG.
 */

import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { establishBmcSession } from "./bmc-session.js";
import type { KvmScreenshotOptions, KvmScreenshotResult } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_FRAME_TIMEOUT = 15_000;

/**
 * Capture a screenshot from an AMI/ASRockRack KVM console.
 *
 * @param viewerUrl - The OVH IPMI viewer URL (redirect page)
 * @param options - Timeout options
 * @returns PNG screenshot with dimensions
 */
export async function captureKvmScreenshot(
	viewerUrl: string,
	options?: KvmScreenshotOptions,
): Promise<KvmScreenshotResult> {
	const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
	const frameTimeout = options?.frameTimeout ?? DEFAULT_FRAME_TIMEOUT;

	// Step 1: Establish BMC session
	const session = await establishBmcSession(viewerUrl);

	// Step 2: Connect to KVM WebSocket
	const wsProto = viewerUrl.startsWith("https") ? "wss" : "ws";
	const wsUrl = `${wsProto}://${session.host}/kvm`;
	const jpegData = await receiveJpegFrame(wsUrl, connectTimeout, frameTimeout);

	// Step 3: Decode JPEG and convert to PNG
	return jpegToPng(jpegData);
}

/**
 * Connect to the KVM WebSocket and receive the first complete JPEG frame.
 * Accumulates data across multiple WebSocket messages, scanning for
 * JPEG SOI (0xFFD8) and EOI (0xFFD9) markers.
 */
async function receiveJpegFrame(
	wsUrl: string,
	connectTimeout: number,
	frameTimeout: number,
): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		let soiOffset = -1;
		let connected = false;
		let settled = false;

		const finish = (err: Error | null, data?: Buffer): void => {
			if (settled) return;
			settled = true;
			clearTimeout(connectTimer);
			clearTimeout(frameTimer);
			try {
				ws.close();
			} catch {
				// ignore close errors
			}
			if (err) reject(err);
			else resolve(data as Buffer);
		};

		const connectTimer = setTimeout(() => {
			if (!connected) {
				finish(new Error(`KVM WebSocket connection timed out after ${connectTimeout}ms`));
			}
		}, connectTimeout);

		const frameTimer = setTimeout(() => {
			finish(new Error(`No JPEG frame received within ${frameTimeout}ms`));
		}, frameTimeout);

		const ws = new WebSocket(wsUrl, ["binary", "base64"]);
		ws.binaryType = "arraybuffer";

		ws.onopen = (): void => {
			connected = true;
			clearTimeout(connectTimer);
		};

		ws.onmessage = (event: MessageEvent): void => {
			let chunk: Buffer;
			if (event.data instanceof ArrayBuffer) {
				chunk = Buffer.from(event.data);
			} else if (typeof event.data === "string") {
				chunk = Buffer.from(event.data, "base64");
			} else {
				return;
			}

			buffer = Buffer.concat([buffer, chunk]);

			// Scan for JPEG markers in the accumulated buffer
			if (soiOffset === -1) {
				soiOffset = findMarker(buffer, 0xff, 0xd8);
			}

			if (soiOffset >= 0) {
				const eoiOffset = findMarker(buffer, 0xff, 0xd9, soiOffset + 2);
				if (eoiOffset >= 0) {
					// Complete JPEG frame found (EOI marker is 2 bytes)
					const jpegData = buffer.subarray(soiOffset, eoiOffset + 2);
					finish(null, Buffer.from(jpegData));
				}
			}
		};

		ws.onerror = (): void => {
			finish(new Error("KVM WebSocket connection error"));
		};

		ws.onclose = (event: CloseEvent): void => {
			if (!settled) {
				finish(new Error(`KVM WebSocket closed before frame received (code: ${event.code})`));
			}
		};
	});
}

/** Find a two-byte marker in a buffer, starting from offset. Returns index or -1. */
function findMarker(buf: Buffer, b1: number, b2: number, start = 0): number {
	for (let i = start; i < buf.length - 1; i++) {
		if (buf[i] === b1 && buf[i + 1] === b2) return i;
	}
	return -1;
}

/** Decode a JPEG buffer and encode as PNG. */
function jpegToPng(jpegData: Buffer): KvmScreenshotResult {
	const decoded = jpeg.decode(jpegData, { useTArray: true });
	const { width, height, data } = decoded;

	const png = new PNG({ width, height });
	png.data = Buffer.from(data);
	const pngBuffer = PNG.sync.write(png);

	return { png: pngBuffer, width, height };
}
