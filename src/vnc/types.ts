/**
 * RFB (Remote Framebuffer) protocol types.
 * Based on RFC 6143 — The Remote Framebuffer Protocol.
 */

/** Supported RFB protocol versions */
export type RfbVersion = "3.3" | "3.7" | "3.8";

/** RFB security types */
export const SecurityType = {
	None: 1,
	VncAuth: 2,
} as const;
export type SecurityType = (typeof SecurityType)[keyof typeof SecurityType];

/** RFB encoding types */
export const EncodingType = {
	Raw: 0,
	CopyRect: 1,
} as const;
export type EncodingType = (typeof EncodingType)[keyof typeof EncodingType];

/** Server-to-client message types */
export const ServerMessageType = {
	FramebufferUpdate: 0,
	SetColourMapEntries: 1,
	Bell: 2,
	ServerCutText: 3,
} as const;
export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

/** Client-to-server message types */
export const ClientMessageType = {
	SetPixelFormat: 0,
	SetEncodings: 2,
	FramebufferUpdateRequest: 3,
	KeyEvent: 4,
	PointerEvent: 5,
	ClientCutText: 6,
} as const;
export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** Pixel format description */
export interface PixelFormat {
	readonly bitsPerPixel: number; // 8, 16, or 32
	readonly depth: number;
	readonly bigEndian: boolean;
	readonly trueColor: boolean;
	readonly redMax: number;
	readonly greenMax: number;
	readonly blueMax: number;
	readonly redShift: number;
	readonly greenShift: number;
	readonly blueShift: number;
}

/** Server initialization message data */
export interface ServerInit {
	readonly width: number;
	readonly height: number;
	readonly pixelFormat: PixelFormat;
	readonly name: string;
}

/** A rectangle within a framebuffer update */
export interface FbRectangle {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly encoding: number;
	readonly data: Uint8Array;
}

/** Raw framebuffer data */
export interface Framebuffer {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array; // RGBA pixel data
}

/** Options for the RFB client */
export interface RfbClientOptions {
	readonly password?: string;
	readonly connectTimeout?: number;
	readonly readTimeout?: number;
}

/** Default RGBA pixel format we request from the server */
export const PIXEL_FORMAT_RGBA: PixelFormat = {
	bitsPerPixel: 32,
	depth: 24,
	bigEndian: false,
	trueColor: true,
	redMax: 255,
	greenMax: 255,
	blueMax: 255,
	redShift: 0,
	greenShift: 8,
	blueShift: 16,
};
