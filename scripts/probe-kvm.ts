/**
 * Probe the AMI KVM WebSocket to understand the packet format.
 * Connects, receives initial data, and dumps packet structure.
 */

import { OvhApiClient } from "../src/providers/ovh/api.js";
import type { OvhTask } from "../src/providers/ovh/types.js";

const endpoint = process.env.OVH_ENDPOINT || "eu";
const applicationKey = process.env.OVH_APPLICATION_KEY;
const applicationSecret = process.env.OVH_APPLICATION_SECRET;
const consumerKey = process.env.OVH_CONSUMER_KEY;

if (!applicationKey || !applicationSecret || !consumerKey) {
	console.error("Missing OVH credentials.");
	process.exit(1);
}

const api = new OvhApiClient({ endpoint, applicationKey, applicationSecret, consumerKey });
await api.syncTime();

const servers = await api.get<string[]>("/dedicated/server");
const serverId = servers[0];
console.log(`Server: ${serverId}`);

// Get public IP
const ipRes = await fetch("https://api.ipify.org?format=json");
const { ip: myIp } = (await ipRes.json()) as { ip: string };
console.log(`Our IP: ${myIp}`);

// Request IPMI access
const task = await api.post<OvhTask>(`/dedicated/server/${serverId}/features/ipmi/access`, {
	type: "kvmipHtml5URL",
	ttl: 15,
	ipToAllow: myIp,
});

// Poll task
for (let i = 0; i < 40; i++) {
	const t = await api.get<OvhTask>(`/dedicated/server/${serverId}/task/${task.taskId}`);
	if (t.status === "done") break;
	if (["cancelled", "customerError", "ovhError"].includes(t.status)) {
		throw new Error(`Task failed: ${t.status}`);
	}
	await new Promise((r) => setTimeout(r, 3000));
}

// Get viewer URL
const access = await api.get<{ value: string; expiration: string }>(
	`/dedicated/server/${serverId}/features/ipmi/access`,
	{ type: "kvmipHtml5URL" },
);
console.log(`Viewer URL: ${access.value}`);

// Step 1: Fetch redirect page and extract session info
const redirectRes = await fetch(access.value, { redirect: "manual" });
const redirectHtml = await redirectRes.text();

// Extract token from URL or page
const tokenMatch = redirectHtml.match(/QSESSIONID['"=\s]+["']?([^"'\s;]+)/);
const garcMatch = redirectHtml.match(/garc['"],\s*['"]([^'"]+)['"]/);

const sessionCookie = tokenMatch ? tokenMatch[1] : "";
const csrfToken = garcMatch ? garcMatch[1] : "";
const viewerHost = new URL(access.value).host;

console.log(`\nSession cookie: ${sessionCookie}`);
console.log(`CSRF token: ${csrfToken}`);
console.log(`Host: ${viewerHost}`);

// Step 2: Connect to KVM WebSocket
const wsUrl = `wss://${viewerHost}/kvm`;
console.log(`\nConnecting to: ${wsUrl}`);

const ws = new WebSocket(wsUrl, ["binary", "base64"]);

let packetCount = 0;
const packets: {
	index: number;
	size: number;
	firstBytes: string;
	hasJpegSoi: boolean;
	hasJpegEoi: boolean;
}[] = [];

ws.binaryType = "arraybuffer";

ws.onopen = () => {
	console.log(`WebSocket connected! Protocol: ${ws.protocol}`);
};

ws.onmessage = (event) => {
	const data = event.data;
	let bytes: Uint8Array;

	if (data instanceof ArrayBuffer) {
		bytes = new Uint8Array(data);
	} else if (typeof data === "string") {
		// base64 encoded
		bytes = new Uint8Array(Buffer.from(data, "base64"));
	} else {
		console.log(`Unknown data type: ${typeof data}`);
		return;
	}

	packetCount++;

	// Check for JPEG markers
	let hasJpegSoi = false;
	let hasJpegEoi = false;
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) hasJpegSoi = true;
		if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) hasJpegEoi = true;
	}

	const firstBytes = Array.from(bytes.slice(0, 32))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(" ");

	packets.push({ index: packetCount, size: bytes.length, firstBytes, hasJpegSoi, hasJpegEoi });

	if (packetCount <= 20) {
		console.log(`\nPacket #${packetCount}: ${bytes.length} bytes`);
		console.log(`  First 32 bytes: ${firstBytes}`);
		console.log(`  JPEG SOI (FFD8): ${hasJpegSoi}, EOI (FFD9): ${hasJpegEoi}`);
	}

	// After receiving enough data, save raw packets for analysis
	if (packetCount >= 20 || (hasJpegSoi && hasJpegEoi)) {
		console.log(`\n=== Summary after ${packetCount} packets ===`);
		for (const p of packets) {
			console.log(
				`  #${p.index}: ${p.size} bytes | SOI=${p.hasJpegSoi} EOI=${p.hasJpegEoi} | ${p.firstBytes.substring(0, 47)}...`,
			);
		}

		// If we found a complete JPEG, save it
		if (hasJpegSoi && hasJpegEoi) {
			// Find SOI and EOI in this packet
			let soiIdx = -1;
			let eoiIdx = -1;
			for (let i = 0; i < bytes.length - 1; i++) {
				if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && soiIdx === -1) soiIdx = i;
				if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) eoiIdx = i + 2;
			}
			if (soiIdx >= 0 && eoiIdx > soiIdx) {
				const jpegFrame = bytes.slice(soiIdx, eoiIdx);
				const outPath = `/tmp/kvm-frame-${Date.now()}.jpg`;
				Bun.write(outPath, jpegFrame).then(() => {
					console.log(`\nSaved JPEG frame: ${outPath} (${jpegFrame.length} bytes)`);
					ws.close();
					process.exit(0);
				});
				return;
			}
		}

		ws.close();
		process.exit(0);
	}
};

ws.onerror = (err) => {
	console.error("WebSocket error:", err);
};

ws.onclose = (event) => {
	console.log(`WebSocket closed: code=${event.code} reason=${event.reason}`);
	if (packetCount === 0) {
		console.log("No packets received. Cookie auth may have failed.");
	}
	process.exit(0);
};

// Timeout after 30 seconds
setTimeout(() => {
	console.log(`\nTimeout after 30s. Received ${packetCount} packets total.`);
	if (packets.length > 0) {
		console.log("=== All packets ===");
		for (const p of packets) {
			console.log(`  #${p.index}: ${p.size} bytes | SOI=${p.hasJpegSoi} EOI=${p.hasJpegEoi}`);
		}
	}
	ws.close();
	process.exit(0);
}, 30000);
