/**
 * RFB framebuffer encoding decoders.
 */

import type { FbRectangle, PixelFormat } from "./types.js";

/**
 * Decode a Raw-encoded rectangle into RGBA pixel data.
 * Raw encoding sends uncompressed pixel data in the server's pixel format.
 */
export function decodeRaw(rect: FbRectangle, serverFormat: PixelFormat): Uint8Array {
	const pixelCount = rect.width * rect.height;
	const bytesPerPixel = serverFormat.bitsPerPixel / 8;
	const rgba = new Uint8Array(pixelCount * 4);

	for (let i = 0; i < pixelCount; i++) {
		const srcOffset = i * bytesPerPixel;
		const dstOffset = i * 4;

		let pixel = 0;
		if (bytesPerPixel === 4) {
			pixel = serverFormat.bigEndian
				? (rect.data[srcOffset] << 24) |
					(rect.data[srcOffset + 1] << 16) |
					(rect.data[srcOffset + 2] << 8) |
					rect.data[srcOffset + 3]
				: rect.data[srcOffset] |
					(rect.data[srcOffset + 1] << 8) |
					(rect.data[srcOffset + 2] << 16) |
					(rect.data[srcOffset + 3] << 24);
		} else if (bytesPerPixel === 2) {
			pixel = serverFormat.bigEndian
				? (rect.data[srcOffset] << 8) | rect.data[srcOffset + 1]
				: rect.data[srcOffset] | (rect.data[srcOffset + 1] << 8);
		} else {
			pixel = rect.data[srcOffset];
		}

		const r =
			((pixel >> serverFormat.redShift) & serverFormat.redMax) * (255 / serverFormat.redMax);
		const g =
			((pixel >> serverFormat.greenShift) & serverFormat.greenMax) * (255 / serverFormat.greenMax);
		const b =
			((pixel >> serverFormat.blueShift) & serverFormat.blueMax) * (255 / serverFormat.blueMax);

		rgba[dstOffset] = r;
		rgba[dstOffset + 1] = g;
		rgba[dstOffset + 2] = b;
		rgba[dstOffset + 3] = 255; // alpha
	}

	return rgba;
}

/**
 * Apply a CopyRect-encoded rectangle to an existing framebuffer.
 * CopyRect encoding references a source position in the existing framebuffer.
 */
export function decodeCopyRect(rect: FbRectangle, framebuffer: Uint8Array, fbWidth: number): void {
	const srcX = (rect.data[0] << 8) | rect.data[1];
	const srcY = (rect.data[2] << 8) | rect.data[3];

	for (let y = 0; y < rect.height; y++) {
		const srcOffset = ((srcY + y) * fbWidth + srcX) * 4;
		const dstOffset = ((rect.y + y) * fbWidth + rect.x) * 4;
		framebuffer.copyWithin(dstOffset, srcOffset, srcOffset + rect.width * 4);
	}
}
