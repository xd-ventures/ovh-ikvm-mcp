// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * OVH API types.
 */

export interface OvhConfig {
	/** API endpoint region: "eu", "ca", or "us" */
	readonly endpoint: string;
	readonly applicationKey: string;
	readonly applicationSecret: string;
	readonly consumerKey: string;
	/** Override base URL (for testing) */
	readonly baseUrl?: string;
}

/** OVH dedicated server details (subset of fields we need) */
export interface OvhDedicatedServer {
	readonly name: string;
	readonly commercialRange?: string;
	readonly datacenter?: string;
	readonly ip?: string;
	readonly os?: string;
	readonly state?: string;
}

/** IPMI access response */
export interface OvhIpmiAccess {
	readonly value: string;
	readonly expiration?: string;
}

/** IPMI feature status */
export interface OvhIpmiStatus {
	readonly activated: boolean;
	readonly supportedFeatures?: {
		readonly kvmipHtml5URL?: boolean;
		readonly kvmipJnlp?: boolean;
		readonly serialOverLanURL?: boolean;
		readonly serialOverLanSshKey?: boolean;
	};
}

/** OVH task (returned by async operations) */
export interface OvhTask {
	readonly taskId: number;
	readonly function: string;
	readonly status: "cancelled" | "customerError" | "doing" | "done" | "init" | "ovhError" | "todo";
	readonly startDate?: string;
	readonly doneDate?: string;
	readonly comment?: string;
}
