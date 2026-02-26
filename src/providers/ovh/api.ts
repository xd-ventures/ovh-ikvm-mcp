/**
 * OVH API client with request signing.
 */

import type { OvhConfig } from "./types.js";

const ENDPOINTS: Record<string, string> = {
	eu: "https://eu.api.ovh.com/1.0",
	ca: "https://ca.api.ovh.com/1.0",
	us: "https://api.us.ovhcloud.com/1.0",
};

export class OvhApiClient {
	private readonly baseUrl: string;
	private readonly config: OvhConfig;
	private timeDelta = 0;

	constructor(config: OvhConfig) {
		this.config = config;
		if (config.baseUrl) {
			this.baseUrl = config.baseUrl;
		} else {
			const base = ENDPOINTS[config.endpoint];
			if (!base) {
				throw new Error(
					`Unknown OVH endpoint: ${config.endpoint}. Valid: ${Object.keys(ENDPOINTS).join(", ")}`,
				);
			}
			this.baseUrl = base;
		}
	}

	/** Sync local time with OVH server time (call once before making requests). */
	async syncTime(): Promise<void> {
		const res = await fetch(`${this.baseUrl}/auth/time`);
		if (!res.ok) {
			throw new Error(`Failed to sync time: ${res.status} ${res.statusText}`);
		}
		const serverTime = (await res.json()) as number;
		this.timeDelta = serverTime - Math.floor(Date.now() / 1000);
	}

	async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		let url = `${this.baseUrl}${path}`;
		if (params) {
			const qs = new URLSearchParams(params).toString();
			url = `${url}?${qs}`;
		}
		return this.request<T>("GET", url, "");
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const bodyStr = body ? JSON.stringify(body) : "";
		return this.request<T>("POST", url, bodyStr);
	}

	private async request<T>(method: string, url: string, body: string): Promise<T> {
		const timestamp = Math.floor(Date.now() / 1000) + this.timeDelta;
		const signature = this.sign(method, url, body, timestamp);

		const headers: Record<string, string> = {
			"X-Ovh-Application": this.config.applicationKey,
			"X-Ovh-Consumer": this.config.consumerKey,
			"X-Ovh-Timestamp": String(timestamp),
			"X-Ovh-Signature": signature,
			"Content-Type": "application/json",
		};

		const res = await fetch(url, {
			method,
			headers,
			body: body || undefined,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`OVH API ${method} ${url}: ${res.status} ${text}`);
		}

		return res.json() as Promise<T>;
	}

	/** Compute OVH API request signature. */
	sign(method: string, url: string, body: string, timestamp: number): string {
		const toSign = [
			this.config.applicationSecret,
			this.config.consumerKey,
			method,
			url,
			body,
			String(timestamp),
		].join("+");

		const hasher = new Bun.CryptoHasher("sha1");
		hasher.update(toSign);
		return `$1$${hasher.digest("hex")}`;
	}
}
