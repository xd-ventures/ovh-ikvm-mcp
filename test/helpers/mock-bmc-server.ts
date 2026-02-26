/**
 * Mock ASRockRack/AMI BMC server for testing.
 *
 * Simulates:
 * 1. HTTP redirect page with QSESSIONID cookie and garc CSRF token
 * 2. WebSocket endpoint at /kvm that sends a test JPEG frame
 */

import type { Server as BunServerType, ServerWebSocket } from "bun";
import * as jpeg from "jpeg-js";

type BunServer = BunServerType<undefined>;

export interface MockBmcServerOptions {
	port?: number;
	/** Session cookie value to set */
	sessionCookie?: string;
	/** CSRF token to embed in page */
	csrfToken?: string;
	/** Test image dimensions */
	width?: number;
	height?: number;
	/** Fill color [R, G, B] for the test image */
	fillColor?: [number, number, number];
	/** Delay before sending JPEG frame (ms) */
	frameDelay?: number;
	/** If true, embed cookie in JS instead of Set-Cookie header */
	cookieInJs?: boolean;
}

export class MockBmcServer {
	private server: BunServer | null = null;
	private readonly options: MockBmcServerOptions;
	private readonly jpegData: Buffer;
	readonly width: number;
	readonly height: number;

	constructor(options: MockBmcServerOptions = {}) {
		this.options = options;
		this.width = options.width ?? 320;
		this.height = options.height ?? 240;

		// Generate a test JPEG image
		this.jpegData = this.generateTestJpeg();
	}

	start(): string {
		const self = this;

		this.server = Bun.serve({
			port: this.options.port ?? 0,
			fetch(req, server) {
				return self.handleRequest(req, server);
			},
			websocket: {
				message(_ws: ServerWebSocket, _message: string | Buffer) {
					// KVM protocol: we ignore client messages in the mock
				},
				open(ws: ServerWebSocket) {
					self.handleWsOpen(ws);
				},
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

	get baseUrl(): string {
		return `http://localhost:${this.port}`;
	}

	private handleRequest(req: Request, server: BunServerType<undefined>): Response | undefined {
		const url = new URL(req.url);

		// WebSocket upgrade for /kvm
		if (url.pathname === "/kvm") {
			if (server.upgrade(req)) {
				return undefined;
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Viewer redirect page (the initial URL from OVH API)
		if (url.pathname === "/viewer" || url.pathname === "/") {
			return this.serveRedirectPage();
		}

		// Viewer.html (the actual viewer page, not used for screenshot capture)
		if (url.pathname === "/viewer.html") {
			return new Response("<html><body>KVM Viewer</body></html>", {
				headers: { "Content-Type": "text/html" },
			});
		}

		return new Response("Not Found", { status: 404 });
	}

	private serveRedirectPage(): Response {
		const cookie = this.options.sessionCookie ?? "test-session-id-12345";
		const csrf = this.options.csrfToken ?? "test-csrf-token-abc";
		const cookieInJs = this.options.cookieInJs ?? false;

		const html = `<!DOCTYPE html>
<html>
<head><title>Redirect</title></head>
<body>
<script>
${cookieInJs ? `document.cookie = "QSESSIONID=${cookie}";` : "// QSESSIONID set via header"}
var garc_token = ["garc", "${csrf}"];
window.location.href = "/viewer.html";
</script>
</body>
</html>`;

		const headers: Record<string, string> = {
			"Content-Type": "text/html",
		};

		if (!cookieInJs) {
			headers["Set-Cookie"] = `QSESSIONID=${cookie}; Path=/; HttpOnly`;
		}

		return new Response(html, { headers });
	}

	private handleWsOpen(ws: ServerWebSocket): void {
		const delay = this.options.frameDelay ?? 10;

		setTimeout(() => {
			// Send a binary WebSocket message containing the JPEG data
			// In the real AMI protocol, the JPEG may be preceded by a small header,
			// but the core approach of scanning for SOI/EOI markers handles both cases.
			ws.send(this.jpegData);
		}, delay);
	}

	private generateTestJpeg(): Buffer {
		const [r, g, b] = this.options.fillColor ?? [0, 128, 255];
		const { width, height } = this;

		// Create RGBA pixel data
		const data = Buffer.alloc(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			data[i * 4] = r;
			data[i * 4 + 1] = g;
			data[i * 4 + 2] = b;
			data[i * 4 + 3] = 255;
		}

		const rawImage = {
			data,
			width,
			height,
		};

		return jpeg.encode(rawImage, 80).data;
	}
}
