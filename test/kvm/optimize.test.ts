// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { optimizeForLlm } from "../../src/kvm/optimize.js";

/** Create a PNG buffer from raw RGBA pixel data. */
function makePng(width: number, height: number, pixels: number[][]): Buffer {
	const png = new PNG({ width, height });
	for (let i = 0; i < pixels.length; i++) {
		const [r, g, b, a] = pixels[i];
		png.data[i * 4] = r;
		png.data[i * 4 + 1] = g;
		png.data[i * 4 + 2] = b;
		png.data[i * 4 + 3] = a;
	}
	return PNG.sync.write(png);
}

describe("optimizeForLlm", () => {
	it("should upscale dimensions by 2x", () => {
		// 4x3 image → 8x6
		const src = makePng(4, 3, Array(12).fill([50, 50, 50, 255]));
		const result = PNG.sync.read(optimizeForLlm(src));
		expect(result.width).toBe(8);
		expect(result.height).toBe(6);
	});

	it("should boost brightness by 3x", () => {
		const src = makePng(1, 1, [[50, 80, 10, 255]]);
		const result = PNG.sync.read(optimizeForLlm(src));
		expect(result.data[0]).toBe(150); // 50 * 3
		expect(result.data[1]).toBe(240); // 80 * 3
		expect(result.data[2]).toBe(30); // 10 * 3
	});

	it("should cap brightness at 255", () => {
		const src = makePng(1, 1, [[100, 200, 255, 255]]);
		const result = PNG.sync.read(optimizeForLlm(src));
		expect(result.data[0]).toBe(255); // 100 * 3 = 300 → 255
		expect(result.data[1]).toBe(255); // 200 * 3 = 600 → 255
		expect(result.data[2]).toBe(255); // 255 * 3 = 765 → 255
	});

	it("should set alpha to 255", () => {
		const src = makePng(1, 1, [[50, 50, 50, 128]]);
		const result = PNG.sync.read(optimizeForLlm(src));
		// All 4 pixels (2x2 upscale of 1x1) should have alpha=255
		for (let i = 0; i < 4; i++) {
			expect(result.data[i * 4 + 3]).toBe(255);
		}
	});

	it("should replicate pixels with nearest-neighbor upscale", () => {
		// 2x1 image: red, blue → 4x2 with each pixel doubled
		const src = makePng(2, 1, [
			[50, 0, 0, 255],
			[0, 0, 50, 255],
		]);
		const result = PNG.sync.read(optimizeForLlm(src));
		expect(result.width).toBe(4);
		expect(result.height).toBe(2);

		// Top-left 2x2 block should be boosted red
		expect(result.data[0]).toBe(150); // (0,0) R
		expect(result.data[4]).toBe(150); // (1,0) R
		expect(result.data[16]).toBe(150); // (0,1) R
		expect(result.data[20]).toBe(150); // (1,1) R

		// Top-right 2x2 block should be boosted blue
		expect(result.data[8 + 2]).toBe(150); // (2,0) B
		expect(result.data[12 + 2]).toBe(150); // (3,0) B
	});

	it("should accept custom scale option", () => {
		const src = makePng(2, 2, Array(4).fill([50, 50, 50, 255]));
		const result = PNG.sync.read(optimizeForLlm(src, { scale: 3 }));
		expect(result.width).toBe(6);
		expect(result.height).toBe(6);
	});

	it("should accept custom brightness option", () => {
		const src = makePng(1, 1, [[100, 100, 100, 255]]);
		const result = PNG.sync.read(optimizeForLlm(src, { brightness: 2 }));
		expect(result.data[0]).toBe(200);
		expect(result.data[1]).toBe(200);
		expect(result.data[2]).toBe(200);
	});

	it("should handle scale=1 (no upscale)", () => {
		const src = makePng(3, 2, Array(6).fill([40, 40, 40, 255]));
		const result = PNG.sync.read(optimizeForLlm(src, { scale: 1 }));
		expect(result.width).toBe(3);
		expect(result.height).toBe(2);
		expect(result.data[0]).toBe(120); // brightness still applied
	});

	it("should handle brightness=1 (no boost)", () => {
		const src = makePng(1, 1, [[77, 88, 99, 255]]);
		const result = PNG.sync.read(optimizeForLlm(src, { brightness: 1 }));
		expect(result.data[0]).toBe(77);
		expect(result.data[1]).toBe(88);
		expect(result.data[2]).toBe(99);
	});
});
