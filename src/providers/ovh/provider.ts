// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * OVH provider — implements the Provider interface for OVH dedicated servers.
 */

import { captureKvmScreenshot } from "../../kvm/screenshot.js";
import type { Provider, Server } from "../types.js";
import { OvhApiClient } from "./api.js";
import type { OvhConfig, OvhDedicatedServer, OvhIpmiAccess, OvhTask } from "./types.js";

const DEFAULT_POLL_INTERVAL = 3_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 40; // 40 * 3s = 2 minutes max

export interface OvhProviderOptions {
	/** Override poll interval in ms (for testing) */
	pollInterval?: number;
	/** Override max poll attempts (for testing) */
	pollMaxAttempts?: number;
	/** Override public IP detection */
	publicIp?: string;
}

export class OvhProvider implements Provider {
	readonly name = "ovh";
	private readonly api: OvhApiClient;
	private readonly pollInterval: number;
	private readonly pollMaxAttempts: number;
	private readonly publicIp?: string;
	private initialized = false;

	constructor(config: OvhConfig, options?: OvhProviderOptions) {
		this.api = new OvhApiClient(config);
		this.pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
		this.pollMaxAttempts = options?.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
		this.publicIp = options?.publicIp;
	}

	private async ensureInit(): Promise<void> {
		if (!this.initialized) {
			await this.api.syncTime();
			this.initialized = true;
		}
	}

	async listServers(): Promise<Server[]> {
		await this.ensureInit();

		const serviceNames = await this.api.get<string[]>("/dedicated/server");
		const servers: Server[] = [];

		for (const name of serviceNames) {
			const details = await this.api.get<OvhDedicatedServer>(`/dedicated/server/${name}`);
			servers.push({
				id: name,
				name: details.name || name,
				provider: this.name,
				datacenter: details.datacenter,
				ip: details.ip,
			});
		}

		return servers;
	}

	async getScreenshot(serverId: string): Promise<Buffer> {
		await this.ensureInit();

		// 1. Request iKVM HTML5 access
		const myIp = this.publicIp ?? (await this.getPublicIp());
		const task = await this.api.post<OvhTask>(
			`/dedicated/server/${serverId}/features/ipmi/access`,
			{
				type: "kvmipHtml5URL",
				ttl: 15,
				ipToAllow: myIp,
			},
		);

		// 2. Wait for task completion
		await this.waitForTask(serverId, task.taskId);

		// 3. Get the viewer URL
		const access = await this.api.get<OvhIpmiAccess>(
			`/dedicated/server/${serverId}/features/ipmi/access`,
			{ type: "kvmipHtml5URL" },
		);

		// 4. Capture screenshot via AMI KVM WebSocket
		const result = await captureKvmScreenshot(access.value);

		return result.png;
	}

	/** Wait for an OVH async task to complete. */
	private async waitForTask(serverId: string, taskId: number): Promise<void> {
		for (let i = 0; i < this.pollMaxAttempts; i++) {
			const task = await this.api.get<OvhTask>(`/dedicated/server/${serverId}/task/${taskId}`);

			if (task.status === "done") return;
			if (
				task.status === "cancelled" ||
				task.status === "customerError" ||
				task.status === "ovhError"
			) {
				throw new Error(`OVH task ${taskId} failed: ${task.status} — ${task.comment}`);
			}

			await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
		}

		throw new Error(
			`OVH task ${taskId} timed out after ${(this.pollMaxAttempts * this.pollInterval) / 1000}s`,
		);
	}

	/** Get public IP of the machine running this server. */
	private async getPublicIp(): Promise<string> {
		const res = await fetch("https://api.ipify.org?format=json");
		if (!res.ok) {
			throw new Error("Failed to determine public IP");
		}
		const data = (await res.json()) as { ip: string };
		return data.ip;
	}
}
