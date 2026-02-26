/**
 * OVH provider — implements the Provider interface for OVH dedicated servers.
 */

import { captureScreenshot } from "../../vnc/screenshot.js";
import type { Provider, Server } from "../types.js";
import { OvhApiClient } from "./api.js";
import type { OvhConfig, OvhDedicatedServer, OvhIpmiAccess, OvhTask } from "./types.js";

const POLL_INTERVAL = 3_000;
const POLL_MAX_ATTEMPTS = 40; // 40 * 3s = 2 minutes max

export class OvhProvider implements Provider {
	readonly name = "ovh";
	private readonly api: OvhApiClient;
	private initialized = false;

	constructor(config: OvhConfig) {
		this.api = new OvhApiClient(config);
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
		const myIp = await this.getPublicIp();
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

		// 4. Extract WebSocket URL from viewer page and capture screenshot
		const wsUrl = await this.extractWebSocketUrl(access.url);
		const result = await captureScreenshot(wsUrl);

		return result.png;
	}

	/** Extract the WebSocket VNC endpoint from the h5viewer page. */
	private async extractWebSocketUrl(viewerUrl: string): Promise<string> {
		// Fetch the viewer HTML page
		const res = await fetch(viewerUrl);
		if (!res.ok) {
			throw new Error(`Failed to fetch viewer page: ${res.status}`);
		}
		const html = await res.text();

		// Look for WebSocket URL patterns in the page source
		// Common patterns: ws(s)://host:port/websockify, or embedded in JS config
		const wsMatch = html.match(/wss?:\/\/[^"'\s]+\/websockify[^"'\s]*/);
		if (wsMatch) {
			return wsMatch[0];
		}

		// Try to find a host/port config and construct the WS URL
		const hostMatch = html.match(/['"]host['"]\s*:\s*['"]([^'"]+)['"]/);
		const portMatch = html.match(/['"]port['"]\s*:\s*['"]?(\d+)['"]?/);
		const pathMatch = html.match(/['"]path['"]\s*:\s*['"]([^'"]+)['"]/);

		if (hostMatch) {
			const host = hostMatch[1];
			const port = portMatch ? portMatch[1] : "443";
			const path = pathMatch ? pathMatch[1] : "websockify";
			const proto = port === "443" ? "wss" : "ws";
			return `${proto}://${host}:${port}/${path}`;
		}

		// Fallback: construct from the viewer URL's origin
		const url = new URL(viewerUrl);
		return `wss://${url.host}/websockify`;
	}

	/** Wait for an OVH async task to complete. */
	private async waitForTask(serverId: string, taskId: number): Promise<void> {
		for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
			const task = await this.api.get<OvhTask>(`/dedicated/server/${serverId}/task/${taskId}`);

			if (task.status === "done") return;
			if (
				task.status === "cancelled" ||
				task.status === "customerError" ||
				task.status === "ovhError"
			) {
				throw new Error(`OVH task ${taskId} failed: ${task.status} — ${task.comment}`);
			}

			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
		}

		throw new Error(
			`OVH task ${taskId} timed out after ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL) / 1000}s`,
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
