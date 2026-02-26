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
	});

	describe("with cookie embedded in JavaScript", () => {
		let bmc: MockBmcServer;
		let baseUrl: string;

		beforeAll(() => {
			bmc = new MockBmcServer({
				sessionCookie: "js-cookie-456",
				csrfToken: "js-csrf-token",
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
	});
});
