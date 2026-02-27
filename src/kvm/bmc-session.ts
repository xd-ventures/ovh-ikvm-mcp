// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 ovh-ikvm-mcp contributors

/**
 * BMC session establishment for AMI/ASRockRack firmware.
 *
 * The OVH IPMI viewer URL serves a redirect page that:
 * 1. Sets a QSESSIONID cookie (via Set-Cookie header or URL token param)
 * 2. Includes a CSRF token (garc) in embedded JavaScript
 * 3. Redirects to /viewer.html
 *
 * After extracting session credentials, we call the BMC's /api/kvm/token
 * endpoint to obtain a one-time KVM authentication token.
 */

import type { BmcSession } from "./types.js";

interface KvmTokenResponse {
	readonly client_ip: string;
	readonly token: string;
	readonly session: string;
}

/**
 * Establish a BMC session by fetching the viewer URL, extracting
 * session credentials, and obtaining a KVM authentication token.
 */
export async function establishBmcSession(viewerUrl: string): Promise<BmcSession> {
	const parsedUrl = new URL(viewerUrl);
	const host = parsedUrl.host;
	const protocol = parsedUrl.protocol;

	// Fetch with redirect: "manual" to capture Set-Cookie from the redirect page
	const res = await fetch(viewerUrl, { redirect: "manual" });
	const html = await res.text();

	// Extract QSESSIONID: prefer Set-Cookie header, then URL token param,
	// then embedded JS patterns
	let sessionCookie = extractCookieFromHeaders(res.headers);

	if (!sessionCookie) {
		// The BMC viewer page sets QSESSIONID from the URL "token" query param:
		//   document.cookie = "QSESSIONID=" + token;
		sessionCookie = parsedUrl.searchParams.get("token") ?? "";
	}

	if (!sessionCookie) {
		sessionCookie = extractCookieFromHtml(html);
	}

	if (!sessionCookie) {
		throw new Error("Failed to extract QSESSIONID from BMC viewer page");
	}

	// Extract CSRF token (garc) from embedded JavaScript
	const csrfToken = extractCsrfToken(html);

	// Activate the session by fetching /viewer.html (like a browser would)
	await fetch(`${protocol}//${host}/viewer.html`, {
		headers: { Cookie: `QSESSIONID=${sessionCookie}` },
	}).catch(() => {
		// Non-critical — some BMC firmwares don't require this step
	});

	// Get KVM authentication token from the BMC API
	const { kvmToken, clientIp } = await fetchKvmToken(host, protocol, sessionCookie, csrfToken);

	return { host, sessionCookie, csrfToken, kvmToken, clientIp };
}

/** Fetch a one-time KVM token from the BMC's /api/kvm/token endpoint. */
async function fetchKvmToken(
	host: string,
	protocol: string,
	sessionCookie: string,
	csrfToken: string,
): Promise<{ kvmToken: string; clientIp: string }> {
	const headers: Record<string, string> = {
		Cookie: `QSESSIONID=${sessionCookie}`,
	};
	if (csrfToken) {
		headers["X-CSRFTOKEN"] = csrfToken;
	}

	const res = await fetch(`${protocol}//${host}/api/kvm/token`, {
		headers,
		redirect: "manual",
	});

	if (res.status !== 200) {
		throw new Error(`Failed to get KVM token: HTTP ${res.status}`);
	}

	const data = (await res.json()) as KvmTokenResponse;
	return { kvmToken: data.token, clientIp: data.client_ip };
}

/** Extract QSESSIONID from Set-Cookie response headers. */
function extractCookieFromHeaders(headers: Headers): string {
	const setCookie = headers.get("set-cookie") ?? "";
	const match = setCookie.match(/QSESSIONID=([^;\s]+)/);
	return match ? match[1] : "";
}

/** Extract QSESSIONID from embedded JavaScript in the HTML page. */
function extractCookieFromHtml(html: string): string {
	// Pattern: QSESSIONID = "value" or QSESSIONID=value or cookie assignments
	const patterns = [
		/QSESSIONID["'=\s]+["']?([^"'\s;]+)/,
		/document\.cookie\s*=\s*["']QSESSIONID=([^"'\s;]+)/,
		/session_id["']\s*[:=]\s*["']([^"']+)/,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return match[1];
	}

	return "";
}

/** Extract the garc CSRF token from embedded JavaScript. */
function extractCsrfToken(html: string): string {
	// Pattern: garc", "tokenvalue" or garc = "tokenvalue"
	const patterns = [/garc['"],\s*['"]([^'"]+)['"]/, /garc["']\s*[:=]\s*["']([^"']+)/];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return match[1];
	}

	return "";
}
