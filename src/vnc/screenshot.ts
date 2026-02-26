/**
 * High-level screenshot capture from a VNC/RFB server over WebSocket.
 */

import { PNG } from "pngjs";
import { RfbClient } from "./rfb-client.js";
import type { Framebuffer, RfbClientOptions } from "./types.js";

export interface ScreenshotResult {
	/** PNG image data */
	readonly png: Buffer;
	/** Framebuffer width in pixels */
	readonly width: number;
	/** Framebuffer height in pixels */
	readonly height: number;
}

/**
 * Connect to a VNC server via WebSocket, capture a single frame, and return it as PNG.
 */
export async function captureScreenshot(
	wsUrl: string,
	options?: RfbClientOptions,
): Promise<ScreenshotResult> {
	const client = new RfbClient(wsUrl, options);

	try {
		await client.connect();
		const framebuffer = await client.capture();
		const png = framebufferToPng(framebuffer);
		return {
			png,
			width: framebuffer.width,
			height: framebuffer.height,
		};
	} finally {
		client.disconnect();
	}
}

/** Encode raw RGBA pixel data as PNG. */
export function framebufferToPng(fb: Framebuffer): Buffer {
	const png = new PNG({ width: fb.width, height: fb.height });
	png.data = Buffer.from(fb.pixels);
	return PNG.sync.write(png);
}
