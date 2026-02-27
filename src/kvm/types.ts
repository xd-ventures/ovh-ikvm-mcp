// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Types for AMI/ASRockRack KVM WebSocket protocol.
 */

/** Authenticated BMC session, ready for KVM WebSocket connection. */
export interface BmcSession {
	readonly host: string;
	readonly sessionCookie: string;
	readonly csrfToken: string;
	readonly kvmToken: string;
	readonly clientIp: string;
}

/** Options for KVM screenshot capture. */
export interface KvmScreenshotOptions {
	/** WebSocket connection timeout in ms (default: 10000) */
	readonly connectTimeout?: number;
	/** Time to wait for a video frame in ms (default: 15000) */
	readonly frameTimeout?: number;
}

/** Result of a KVM screenshot capture. */
export interface KvmScreenshotResult {
	/** PNG image data */
	readonly png: Buffer;
	/** Image width in pixels */
	readonly width: number;
	/** Image height in pixels */
	readonly height: number;
}
