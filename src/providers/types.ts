// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * Provider interface — abstraction over bare metal server providers.
 * Each provider (OVH, Hetzner, etc.) implements this interface.
 */

export interface Server {
	/** Provider-specific server identifier */
	readonly id: string;
	/** Human-readable server name */
	readonly name: string;
	/** Provider name (e.g., "ovh") */
	readonly provider: string;
	/** Datacenter location */
	readonly datacenter?: string;
	/** Primary IP address */
	readonly ip?: string;
}

export interface Provider {
	/** Provider name */
	readonly name: string;

	/** List all servers accessible with the configured credentials. */
	listServers(): Promise<Server[]>;

	/**
	 * Capture a screenshot of the server's iKVM/IPMI console.
	 * Returns PNG image data.
	 */
	getScreenshot(serverId: string): Promise<Buffer>;
}
