/**
 * Mock OVH API server for testing.
 * Simulates OVH API endpoints with proper header validation.
 */

import type { Server as BunServer } from "bun";

type HttpServer = BunServer<undefined>;

export interface MockOvhApiOptions {
	port?: number;
	/** Servers to return from GET /dedicated/server */
	servers?: string[];
	/** Server details keyed by service name */
	serverDetails?: Record<string, MockServerDetails>;
	/** IPMI status per server */
	ipmiStatus?: Record<string, MockIpmiStatus>;
	/** Viewer URLs per server (returned after IPMI access request) */
	viewerUrls?: Record<string, string>;
	/** If true, tasks are created as "done" immediately */
	autoCompleteTasks?: boolean;
}

export interface MockServerDetails {
	name: string;
	datacenter?: string;
	ip?: string;
	commercialRange?: string;
	os?: string;
	state?: string;
}

export interface MockIpmiStatus {
	activated: boolean;
	supportedFeatures?: {
		kvmipHtml5URL?: boolean;
	};
}

interface TaskState {
	taskId: number;
	status: string;
	serverId: string;
	comment?: string;
}

export class MockOvhApi {
	private server: HttpServer | null = null;
	private readonly options: MockOvhApiOptions;
	private taskCounter = 0;
	private tasks: Map<number, TaskState> = new Map();
	readonly requests: Array<{ method: string; path: string; headers: Record<string, string> }> = [];

	constructor(options: MockOvhApiOptions = {}) {
		this.options = options;
	}

	start(): string {
		const self = this;

		this.server = Bun.serve({
			port: this.options.port ?? 0,
			fetch(req) {
				return self.handleRequest(req);
			},
		});

		return `http://localhost:${this.server.port}`;
	}

	stop(): void {
		if (this.server) {
			this.server.stop(true);
			this.server = null;
		}
	}

	get port(): number {
		return this.server?.port ?? 0;
	}

	/** Clear recorded requests (useful for test isolation between tests). */
	clearRequests(): void {
		this.requests.length = 0;
	}

	/** Complete all pending tasks (simulates async IPMI access becoming ready) */
	completeTasks(): void {
		for (const task of this.tasks.values()) {
			task.status = "done";
		}
	}

	/** Fail a specific task with a given status and optional comment. */
	failTask(taskId: number, status: string, comment?: string): void {
		const task = this.tasks.get(taskId);
		if (task) {
			task.status = status;
			task.comment = comment;
		}
	}

	private handleRequest(req: Request): Response {
		const url = new URL(req.url);
		const path = url.pathname.replace(/^\/1\.0/, "");

		// Record the request for assertions
		const headers: Record<string, string> = {};
		for (const [key, value] of req.headers.entries()) {
			headers[key] = value;
		}
		this.requests.push({ method: req.method, path, headers });

		// Auth time endpoint (no auth required)
		if (path === "/auth/time") {
			return Response.json(Math.floor(Date.now() / 1000));
		}

		// Validate auth headers
		if (!headers["x-ovh-application"] || !headers["x-ovh-signature"]) {
			return Response.json({ message: "Invalid credentials" }, { status: 401 });
		}

		return this.routeRequest(req.method, path, url);
	}

	private routeRequest(method: string, path: string, url: URL): Response {
		// GET /dedicated/server
		if (method === "GET" && path === "/dedicated/server") {
			return Response.json(this.options.servers ?? []);
		}

		// GET /dedicated/server/{name}/features/ipmi/access?type=...
		const ipmiAccessMatch = path.match(/^\/dedicated\/server\/([^/]+)\/features\/ipmi\/access$/);
		if (ipmiAccessMatch) {
			const serverId = ipmiAccessMatch[1];

			if (method === "POST") {
				this.taskCounter++;
				const taskId = this.taskCounter;
				const status = this.options.autoCompleteTasks ? "done" : "doing";
				this.tasks.set(taskId, { taskId, status, serverId });
				// The real OVH API always returns "doing" on POST — the task status is
				// obtained by polling GET /task/{id}. We mirror that behaviour here.
				return Response.json({
					taskId,
					function: "ipmiAccessSet",
					status: "doing",
				});
			}

			if (method === "GET") {
				const viewerUrl = this.options.viewerUrls?.[serverId];
				if (!viewerUrl) {
					return Response.json({ message: "No IPMI access" }, { status: 404 });
				}
				return Response.json({
					value: viewerUrl,
					type: url.searchParams.get("type") ?? "kvmipHtml5URL",
					expiration: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
				});
			}
		}

		// GET /dedicated/server/{name}/features/ipmi
		const ipmiStatusMatch = path.match(/^\/dedicated\/server\/([^/]+)\/features\/ipmi$/);
		if (method === "GET" && ipmiStatusMatch) {
			const name = ipmiStatusMatch[1];
			const status = this.options.ipmiStatus?.[name] ?? { activated: true };
			return Response.json(status);
		}

		// GET /dedicated/server/{name}/task/{taskId}
		const taskMatch = path.match(/^\/dedicated\/server\/[^/]+\/task\/(\d+)$/);
		if (method === "GET" && taskMatch) {
			const taskId = Number.parseInt(taskMatch[1]);
			const task = this.tasks.get(taskId);
			if (!task) {
				return Response.json({ message: "Task not found" }, { status: 404 });
			}
			return Response.json({
				taskId: task.taskId,
				function: "ipmiAccessSet",
				status: task.status,
				comment: task.comment ?? null,
			});
		}

		// GET /dedicated/server/{name}
		const serverDetailMatch = path.match(/^\/dedicated\/server\/([^/]+)$/);
		if (method === "GET" && serverDetailMatch) {
			const name = serverDetailMatch[1];
			const details = this.options.serverDetails?.[name];
			if (!details) {
				return Response.json({ message: "Server not found" }, { status: 404 });
			}
			return Response.json(details);
		}

		return Response.json({ message: "Not found" }, { status: 404 });
	}
}
