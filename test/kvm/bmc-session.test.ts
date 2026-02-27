// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { establishBmcSession } from "../../src/kvm/bmc-session.js";
import { MockBmcServer } from "../helpers/mock-bmc-server.js";

describe("establishBmcSession", () => {
	describe("with Set-Cookie header", () => {
		let bmc: MockBmcServer;
		let baseUrl: string;

		beforeAll(() => {
			bmc = new MockBmcServer({
				sessionCookie: "abc123-session",
				csrfToken: "csrf-xyz-789",
				kvmToken: "kvm-tok-111",
				clientIp: "10.0.0.1",
			});
			baseUrl = bmc.start();
		});

		afterAll(() => {
			bmc.stop();
		});

		it("should extract session cookie from Set-Cookie header", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.sessionCookie).toBe("abc123-session");
		});

		it("should extract CSRF token from embedded JavaScript", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.csrfToken).toBe("csrf-xyz-789");
		});

		it("should extract the host from the viewer URL", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.host).toBe(`localhost:${bmc.port}`);
		});

		it("should obtain KVM token from /api/kvm/token", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.kvmToken).toBe("kvm-tok-111");
		});

		it("should obtain client IP from /api/kvm/token", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.clientIp).toBe("10.0.0.1");
		});
	});

	describe("with cookie embedded in JavaScript", () => {
		let bmc: MockBmcServer;
		let baseUrl: string;

		beforeAll(() => {
			bmc = new MockBmcServer({
				sessionCookie: "js-cookie-456",
				csrfToken: "js-csrf-token",
				kvmToken: "kvm-tok-222",
				clientIp: "192.168.1.1",
				cookieInJs: true,
			});
			baseUrl = bmc.start();
		});

		afterAll(() => {
			bmc.stop();
		});

		it("should extract session cookie from JavaScript source", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.sessionCookie).toBe("js-cookie-456");
		});

		it("should extract CSRF token from JavaScript source", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.csrfToken).toBe("js-csrf-token");
		});

		it("should obtain KVM token from /api/kvm/token", async () => {
			const session = await establishBmcSession(`${baseUrl}/viewer`);
			expect(session.kvmToken).toBe("kvm-tok-222");
		});
	});
});
