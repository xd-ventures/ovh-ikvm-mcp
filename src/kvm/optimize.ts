/**
 * Post-processing to make KVM screenshots readable by LLM vision.
 *
 * Default: 2x nearest-neighbor upscale + 3x brightness boost.
 * This transforms the typically dark, tiny 800x600 BMC output into
 * something Claude's vision can actually read.
 */

import { PNG } from "pngjs";

export interface OptimizeOptions {
	/** Upscale factor (default: 2) */
	readonly scale?: number;
	/** Brightness multiplier (default: 3) */
	readonly brightness?: number;
}

const DEFAULT_SCALE = 2;
const DEFAULT_BRIGHTNESS = 3;

/**
 * Upscale and brighten a PNG buffer for LLM vision readability.
 */
export function optimizeForLlm(pngBuffer: Buffer, options?: OptimizeOptions): Buffer {
	const scale = options?.scale ?? DEFAULT_SCALE;
	const brightness = options?.brightness ?? DEFAULT_BRIGHTNESS;

	const src = PNG.sync.read(pngBuffer);
	const dst = new PNG({ width: src.width * scale, height: src.height * scale });

	for (let y = 0; y < src.height; y++) {
		for (let x = 0; x < src.width; x++) {
			const si = (y * src.width + x) * 4;
			const r = Math.min(Math.round(src.data[si] * brightness), 255);
			const g = Math.min(Math.round(src.data[si + 1] * brightness), 255);
			const b = Math.min(Math.round(src.data[si + 2] * brightness), 255);

			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const di = ((y * scale + dy) * dst.width + (x * scale + dx)) * 4;
					dst.data[di] = r;
					dst.data[di + 1] = g;
					dst.data[di + 2] = b;
					dst.data[di + 3] = 255;
				}
			}
		}
	}

	return PNG.sync.write(dst);
}
