/**
 * KVM screenshot capture via AMI/ASRockRack IVTP WebSocket protocol.
 *
 * Implements the IVTP (Intelligent Video Transport Protocol) handshake:
 * 1. Connect WebSocket with session cookie, origin, and binary protocol
 * 2. Wait for CMD_CONNECTION_ALLOWED
 * 3. Send combined packet: CONNECTION_COMPLETE + VALIDATE_VIDEO_SESSION + RESUME_REDIRECTION
 * 4. Wait for CMD_VALIDATED_VIDEO_SESSION (success)
 * 5. Request full screen via CMD_POWER_STATUS → CMD_RESUME + CMD_GET_FULL_SCREEN
 * 6. Receive CMD_VIDEO_PACKETS, accumulate all fragments
 * 7. Decode AST2500 compressed tiles → RGBA → PNG
 */

import { PNG } from "pngjs";
import { establishBmcSession } from "./bmc-session.js";
import { createImageData, fetchDecoder } from "./decoder-fetcher.js";
import type { BmcSession, KvmScreenshotOptions, KvmScreenshotResult } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_FRAME_TIMEOUT = 15_000;

/** IVTP protocol constants (from AMI BMC firmware). */
const IVTP = {
	HDR_SIZE: 8,
	VIDEO_PACKET_SIZE: 373,
	SSI_HASH_SIZE: 129,
	CLINET_OWN_IP_LENGTH: 65,
	CLIENT_USERNAME_LENGTH: 129,
	CLINET_OWN_MAC_LENGTH: 49,

	CMD_RESUME_REDIRECTION: 0x06,
	CMD_GET_FULL_SCREEN: 0x0b,
	CMD_VALIDATE_VIDEO_SESSION: 0x12,
	CMD_VALIDATED_VIDEO_SESSION: 0x13,
	CMD_CONNECTION_ALLOWED: 0x17,
	CMD_VIDEO_PACKETS: 0x19,
	CMD_POWER_STATUS: 0x22,
	CMD_CONNECTION_COMPLETE_PKT: 0x3a,
} as const;

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

	// Step 1: Establish BMC session (cookie + CSRF + KVM token)
	const session = await establishBmcSession(viewerUrl);

	// Step 2: Connect to KVM WebSocket and capture frame via IVTP protocol
	const wsProto = viewerUrl.startsWith("https") ? "wss" : "ws";
	const wsUrl = `${wsProto}://${session.host}/kvm`;
	const frame = await captureVideoFrame(wsUrl, session, connectTimeout, frameTimeout);

	// Step 3: Fetch decoder from BMC and decode AST2500 tiles to PNG
	return decodeFrameToPng(frame, session);
}

/** Video frame data: header info + compressed tile data chunks. */
interface VideoFrame {
	readonly width: number;
	readonly height: number;
	readonly headerBytes: Buffer;
	readonly compressedChunks: Buffer[];
	readonly compressSize: number;
}

/** Create an IVTP packet header (8 bytes). */
function createIvtpHeader(type: number, pktsize: number, status: number): ArrayBuffer {
	const buf = new ArrayBuffer(IVTP.HDR_SIZE);
	const view = new DataView(buf);
	view.setUint16(0, type, true);
	view.setUint32(2, pktsize, true);
	view.setUint16(6, status, true);
	return buf;
}

/** Parse an IVTP packet header from a buffer. */
function parseIvtpHeader(data: Uint8Array): { type: number; pktsize: number; status: number } {
	const view = new DataView(data.buffer, data.byteOffset, IVTP.HDR_SIZE);
	return {
		type: view.getUint16(0, true),
		pktsize: view.getUint32(2, true),
		status: view.getUint16(6, true),
	};
}

/** Write a null-terminated, zero-padded C string into a buffer. */
function writeCString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
	const bytes = new TextEncoder().encode(str);
	buf.set(bytes.subarray(0, Math.min(bytes.length, maxLen - 1)), offset);
}

/**
 * Build the combined authentication packet sent after CMD_CONNECTION_ALLOWED.
 */
function buildAuthPacket(session: BmcSession): ArrayBuffer {
	const totalSize = IVTP.HDR_SIZE + IVTP.HDR_SIZE + IVTP.VIDEO_PACKET_SIZE + IVTP.HDR_SIZE;
	const buf = new ArrayBuffer(totalSize);
	const view = new DataView(buf);
	let pos = 0;

	// 1. CMD_CONNECTION_COMPLETE_PKT (type=0x3a, pktsize=0, status=1)
	view.setUint16(pos, IVTP.CMD_CONNECTION_COMPLETE_PKT, true);
	pos += 2;
	view.setUint32(pos, 0, true);
	pos += 4;
	view.setUint16(pos, 1, true);
	pos += 2;

	// 2. CMD_VALIDATE_VIDEO_SESSION (type=0x12, pktsize=373, status=1)
	view.setUint16(pos, IVTP.CMD_VALIDATE_VIDEO_SESSION, true);
	pos += 2;
	view.setUint32(pos, IVTP.VIDEO_PACKET_SIZE, true);
	pos += 4;
	view.setUint16(pos, 1, true);
	pos += 2;

	const authData = new Uint8Array(buf, pos, IVTP.VIDEO_PACKET_SIZE);
	let authOffset = 0;
	authData[authOffset] = 0;
	authOffset += 1;
	writeCString(authData, authOffset, session.kvmToken, IVTP.SSI_HASH_SIZE);
	authOffset += IVTP.SSI_HASH_SIZE;
	writeCString(authData, authOffset, session.clientIp, IVTP.CLINET_OWN_IP_LENGTH);
	authOffset += IVTP.CLINET_OWN_IP_LENGTH;
	writeCString(authData, authOffset, "domain/username", IVTP.CLIENT_USERNAME_LENGTH);
	authOffset += IVTP.CLIENT_USERNAME_LENGTH;
	writeCString(authData, authOffset, "00-00-00-00-00-00", IVTP.CLINET_OWN_MAC_LENGTH);
	pos += IVTP.VIDEO_PACKET_SIZE;

	// 3. CMD_RESUME_REDIRECTION (type=0x06, pktsize=0, status=0)
	view.setUint16(pos, IVTP.CMD_RESUME_REDIRECTION, true);
	pos += 2;
	view.setUint32(pos, 0, true);
	pos += 4;
	view.setUint16(pos, 0, true);

	return buf;
}

/**
 * Connect to the KVM WebSocket, perform the IVTP handshake,
 * and receive a complete video frame (all packets).
 */
async function captureVideoFrame(
	wsUrl: string,
	session: BmcSession,
	connectTimeout: number,
	frameTimeout: number,
): Promise<VideoFrame> {
	return new Promise<VideoFrame>((resolve, reject) => {
		let recvBuf = Buffer.alloc(0);
		let connected = false;
		let settled = false;
		let fullScreenRequested = false;

		// Video frame accumulation
		let headerBytes: Buffer | null = null;
		let headerLen = 0;
		let frameWidth = 0;
		let frameHeight = 0;
		let compressSize = 0;
		const compressedChunks: Buffer[] = [];
		let receivedCompressedBytes = 0;
		let isFirstPacket = true;

		const finish = (err: Error | null, frame?: VideoFrame): void => {
			if (settled) return;
			settled = true;
			clearTimeout(connectTimer);
			clearTimeout(frameTimer);
			try {
				ws.close();
			} catch {
				// ignore
			}
			if (err) reject(err);
			else resolve(frame as VideoFrame);
		};

		const connectTimer = setTimeout(() => {
			if (!connected)
				finish(new Error(`KVM WebSocket connection timed out after ${connectTimeout}ms`));
		}, connectTimeout);

		const frameTimer = setTimeout(() => {
			finish(new Error(`No complete video frame received within ${frameTimeout}ms`));
		}, frameTimeout);

		// biome-ignore lint: Bun's WebSocket supports headers option (non-standard)
		const ws = new (WebSocket as any)(wsUrl, {
			headers: {
				Cookie: `QSESSIONID=${session.sessionCookie}`,
				Origin: `https://${session.host}`,
				"Sec-WebSocket-Protocol": "binary, base64",
			},
		});
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
			recvBuf = Buffer.concat([recvBuf, chunk]);
			processMessages();
		};

		ws.onerror = (): void => {
			finish(new Error("KVM WebSocket connection error"));
		};

		ws.onclose = (event: CloseEvent): void => {
			if (!settled)
				finish(new Error(`KVM WebSocket closed before frame received (code: ${event.code})`));
		};

		function processMessages(): void {
			while (recvBuf.length >= IVTP.HDR_SIZE) {
				const hdr = parseIvtpHeader(recvBuf);
				const totalLen = IVTP.HDR_SIZE + hdr.pktsize;
				if (recvBuf.length < totalLen) break;
				const payload = Buffer.from(recvBuf.subarray(IVTP.HDR_SIZE, totalLen));
				recvBuf = Buffer.from(recvBuf.subarray(totalLen));
				handleMessage(hdr.type, hdr.status, payload);
			}
		}

		function handleMessage(type: number, _status: number, payload: Buffer): void {
			switch (type) {
				case IVTP.CMD_CONNECTION_ALLOWED:
					ws.send(buildAuthPacket(session));
					break;

				case IVTP.CMD_VALIDATED_VIDEO_SESSION: {
					const result = payload.length > 0 ? payload[0] : 0;
					if (result === 1) {
						ws.send(createIvtpHeader(IVTP.CMD_POWER_STATUS, 0, 0));
					} else {
						finish(new Error(`KVM session validation failed (code: ${result})`));
					}
					break;
				}

				case IVTP.CMD_POWER_STATUS:
					if (!fullScreenRequested) {
						fullScreenRequested = true;
						ws.send(createIvtpHeader(IVTP.CMD_RESUME_REDIRECTION, 0, 0));
						ws.send(createIvtpHeader(IVTP.CMD_GET_FULL_SCREEN, 0, 0));
					}
					break;

				case IVTP.CMD_VIDEO_PACKETS:
					handleVideoPacket(payload);
					break;

				default:
					break;
			}
		}

		function handleVideoPacket(payload: Buffer): void {
			if (payload.length < 4) return;

			const FRAG_SIZE = 2;

			if (isFirstPacket) {
				isFirstPacket = false;
				// First packet: fragment(2) + header(headerLen) + compressed data
				const dv = new DataView(payload.buffer, payload.byteOffset);
				headerLen = dv.getUint16(4, true); // wHeaderLen at offset 4 of payload
				frameWidth = dv.getUint16(6, true);
				frameHeight = dv.getUint16(8, true);
				compressSize = dv.getUint32(71, true);
				headerBytes = Buffer.from(payload.subarray(FRAG_SIZE, FRAG_SIZE + headerLen));

				const dataStart = FRAG_SIZE + headerLen;
				if (payload.length > dataStart) {
					const chunk = Buffer.from(payload.subarray(dataStart));
					compressedChunks.push(chunk);
					receivedCompressedBytes += chunk.length;
				}
			} else {
				// Subsequent packets: fragment(2) + compressed data
				if (payload.length > FRAG_SIZE) {
					const chunk = Buffer.from(payload.subarray(FRAG_SIZE));
					compressedChunks.push(chunk);
					receivedCompressedBytes += chunk.length;
				}
			}

			// Check if we've received the complete frame
			if (compressSize > 0 && receivedCompressedBytes >= compressSize && headerBytes) {
				finish(null, {
					width: frameWidth,
					height: frameHeight,
					headerBytes,
					compressedChunks,
					compressSize,
				});
			}
		}
	});
}

/** Decode AST2500 compressed video frame to PNG using runtime-fetched decoder. */
async function decodeFrameToPng(
	frame: VideoFrame,
	session: BmcSession,
): Promise<KvmScreenshotResult> {
	const { width, height, headerBytes, compressedChunks, compressSize } = frame;

	// Parse video engine info from header
	const hdr = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.length);
	// Header field offsets (86-byte AST2500 video engine header):
	//  0: iEngineVersion(2)  2: wHeaderLen(2)  4: Source.X(2)  6: Source.Y(2)
	//  8: Source.ColorDepth(2)  10: Source.RefreshRate(2)  12: Source.ModeIndex(1)
	// 13: Dest.X(2)  15: Dest.Y(2)  17: Dest.ColorDepth(2)  19: Dest.RefreshRate(2)
	// 21: Dest.ModeIndex(1)  22: StartCode(4)  26: FrameNumber(4)  30: HSize(2)
	// 32: VSize(2)  34: reserved(8)  42: CompressionMode(1)  43: JPEGScaleFactor(1)
	// 44: JPEGTableSelector(1)  45: JPEGYUVTableMapping(1)  46: SharpModeSelection(1)
	// 47: AdvanceTableSelector(1)  48: AdvanceScaleFactor(1)  49: NumberOfMB(4)
	// 53: RC4Enable(1)  54: RC4Reset(1)  55: Mode420(1)  56..85: INFData etc.
	const videoinfo = {
		iEngineVersion: hdr.getUint16(0, true),
		wHeaderLen: hdr.getUint16(2, true),
		SourceModeInfo: { X: hdr.getUint16(4, true), Y: hdr.getUint16(6, true) },
		DestinationModeInfo: { X: hdr.getUint16(13, true), Y: hdr.getUint16(15, true) },
		FrameHeader: {
			CompressionMode: hdr.getUint8(42),
			JPEGScaleFactor: hdr.getUint8(43),
			JPEGTableSelector: hdr.getUint8(44),
			JPEGYUVTableMapping: hdr.getUint8(45),
			SharpModeSelection: hdr.getUint8(46),
			AdvanceTableSelector: hdr.getUint8(47),
			AdvanceScaleFactor: hdr.getUint8(48),
			NumberOfMB: hdr.getUint32(49, true),
			RC4Enable: hdr.getUint8(53),
			RC4Reset: hdr.getUint8(54),
		},
		Mode420: hdr.getUint8(55),
		INFData: {
			DownScalingMethod: hdr.getUint8(56),
			DifferentialSetting: hdr.getUint8(57),
		},
		CompressData: { CompressSize: compressSize },
	};

	// Assemble compressed data
	const compressedData = Buffer.concat(compressedChunks);

	// Align to 4 bytes and create Int32Array
	const alignedLen = Math.ceil(compressedData.length / 4) * 4;
	const alignedBuf = new ArrayBuffer(alignedLen);
	new Uint8Array(alignedBuf).set(compressedData);
	const recvBuffer = new Int32Array(alignedBuf);

	// Decode using runtime-fetched decoder from BMC
	const decoderFactory = await fetchDecoder(session.host, session.sessionCookie);
	const decoder = decoderFactory();
	const imageBuffer = createImageData(width, height);
	decoder.setImageBuffer(imageBuffer);
	decoder.decode(videoinfo, recvBuffer);

	// Convert RGBA to PNG
	const png = new PNG({ width, height });
	png.data = Buffer.from(imageBuffer.data);
	const pngBuffer = PNG.sync.write(png);

	return { png: pngBuffer, width, height };
}
