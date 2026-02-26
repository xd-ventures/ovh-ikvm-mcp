/**
 * BMC session establishment for AMI/ASRockRack firmware.
 *
 * The OVH IPMI viewer URL serves a redirect page that:
 * 1. Sets a QSESSIONID cookie (via Set-Cookie header or embedded JS)
 * 2. May include a CSRF token (garc) in embedded JavaScript
 * 3. Redirects to /viewer.html
 *
 * We parse these credentials to authenticate the KVM WebSocket connection.
 */

import type { BmcSession } from "./types.js";

/**
 * Establish a BMC session by fetching the viewer URL and extracting
 * the session cookie and CSRF token.
 */
export async function establishBmcSession(viewerUrl: string): Promise<BmcSession> {
	const host = new URL(viewerUrl).host;

	// Fetch with redirect: "manual" to capture Set-Cookie from the redirect page
	const res = await fetch(viewerUrl, { redirect: "manual" });
	const html = await res.text();

	// Extract QSESSIONID from Set-Cookie header
	let sessionCookie = extractCookieFromHeaders(res.headers);

	// Fallback: extract from embedded JavaScript in the page
	if (!sessionCookie) {
		sessionCookie = extractCookieFromHtml(html);
	}

	if (!sessionCookie) {
		throw new Error("Failed to extract QSESSIONID from BMC viewer page");
	}

	// Extract CSRF token (garc) from embedded JavaScript
	const csrfToken = extractCsrfToken(html);

	return { host, sessionCookie, csrfToken };
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
