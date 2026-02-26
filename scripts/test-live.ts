/**
 * Live test script — tests against real OVH API.
 * Run: bun scripts/test-live.ts
 */

import { OvhApiClient } from "../src/providers/ovh/api.js";
import type { OvhIpmiAccess, OvhIpmiStatus, OvhTask } from "../src/providers/ovh/types.js";

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

// Step 1: List servers
console.log("=== Listing servers ===");
const servers = await api.get<string[]>("/dedicated/server");
console.log(`Found ${servers.length} server(s): ${servers.join(", ")}`);

if (servers.length === 0) {
	console.log("No servers found.");
	process.exit(0);
}

const serverId = servers[0];

// Step 2: Check IPMI status
console.log(`\n=== IPMI status for ${serverId} ===`);
const ipmiStatus = await api.get<OvhIpmiStatus>(`/dedicated/server/${serverId}/features/ipmi`);
console.log(JSON.stringify(ipmiStatus, null, 2));

// Step 3: Request IPMI access
console.log("\n=== Requesting IPMI access ===");

// Get our public IP
const ipRes = await fetch("https://api.ipify.org?format=json");
const { ip: myIp } = (await ipRes.json()) as { ip: string };
console.log(`Our public IP: ${myIp}`);

const task = await api.post<OvhTask>(`/dedicated/server/${serverId}/features/ipmi/access`, {
	type: "kvmipHtml5URL",
	ttl: 15,
	ipToAllow: myIp,
});
console.log(`Task created: ${JSON.stringify(task)}`);

// Step 4: Poll task
console.log(`\n=== Polling task ${task.taskId} ===`);
for (let i = 0; i < 40; i++) {
	const taskStatus = await api.get<OvhTask>(`/dedicated/server/${serverId}/task/${task.taskId}`);
	console.log(`  Attempt ${i + 1}: status=${taskStatus.status}`);
	if (taskStatus.status === "done") break;
	if (["cancelled", "customerError", "ovhError"].includes(taskStatus.status)) {
		console.error(`Task failed: ${taskStatus.status} — ${taskStatus.comment}`);
		process.exit(1);
	}
	await new Promise((r) => setTimeout(r, 3000));
}

// Step 5: Get viewer URL
console.log("\n=== Getting viewer URL ===");
const access = await api.get<OvhIpmiAccess>(`/dedicated/server/${serverId}/features/ipmi/access`, {
	type: "kvmipHtml5URL",
});
console.log(`Viewer URL: ${access.value}`);
console.log(`Full access response: ${JSON.stringify(access, null, 2)}`);

if (!access.value) {
	console.error("No viewer URL returned.");
	process.exit(1);
}

// Step 6: Fetch the viewer page and extract WebSocket URL
console.log("\n=== Fetching viewer page ===");
const viewerRes = await fetch(access.value);
console.log(`Status: ${viewerRes.status}`);
const html = await viewerRes.text();
console.log(`HTML length: ${html.length}`);
console.log(`First 2000 chars:\n${html.substring(0, 2000)}`);

// Try to extract WS URL patterns
const wsMatch = html.match(/wss?:\/\/[^"'\s]+\/websockify[^"'\s]*/);
console.log(`\nDirect WS match: ${wsMatch ? wsMatch[0] : "none"}`);

const hostMatch = html.match(/['"]?host['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
const portMatch = html.match(/['"]?port['"]?\s*[:=]\s*['"]?(\d+)['"]?/);
const pathMatch = html.match(/['"]?path['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
console.log(`Host match: ${hostMatch ? hostMatch[1] : "none"}`);
console.log(`Port match: ${portMatch ? portMatch[1] : "none"}`);
console.log(`Path match: ${pathMatch ? pathMatch[1] : "none"}`);
