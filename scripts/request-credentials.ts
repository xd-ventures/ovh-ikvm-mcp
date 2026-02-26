/**
 * Request OVH consumer key with the required permissions.
 * Run: bun scripts/request-credentials.ts
 *
 * Requires OVH_APPLICATION_KEY and OVH_ENDPOINT to be set.
 */

const endpoint = process.env.OVH_ENDPOINT || "eu";
const applicationKey = process.env.OVH_APPLICATION_KEY;

if (!applicationKey) {
	console.error("Set OVH_APPLICATION_KEY first.");
	process.exit(1);
}

const endpointUrls: Record<string, string> = {
	eu: "https://eu.api.ovh.com/1.0",
	"ovh-eu": "https://eu.api.ovh.com/1.0",
	ca: "https://ca.api.ovh.com/1.0",
	"ovh-ca": "https://ca.api.ovh.com/1.0",
	us: "https://api.us.ovhcloud.com/1.0",
	"ovh-us": "https://api.us.ovhcloud.com/1.0",
};

const baseUrl = endpointUrls[endpoint];
if (!baseUrl) {
	console.error(`Unknown endpoint: ${endpoint}`);
	process.exit(1);
}

const res = await fetch(`${baseUrl}/auth/credential`, {
	method: "POST",
	headers: {
		"X-Ovh-Application": applicationKey,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		accessRules: [
			{ method: "GET", path: "/dedicated/server" },
			{ method: "GET", path: "/dedicated/server/*" },
			{ method: "POST", path: "/dedicated/server/*/features/ipmi/access" },
			{ method: "GET", path: "/dedicated/server/*/features/ipmi/access" },
			{ method: "GET", path: "/dedicated/server/*/features/ipmi" },
			{ method: "GET", path: "/dedicated/server/*/task/*" },
		],
	}),
});

if (!res.ok) {
	console.error(`Failed: ${res.status} ${await res.text()}`);
	process.exit(1);
}

const data = (await res.json()) as {
	validationUrl: string;
	consumerKey: string;
	state: string;
};

console.log("=== OVH Consumer Key Request ===");
console.log(`Consumer Key: ${data.consumerKey}`);
console.log(`State: ${data.state}`);
console.log("\nOpen this URL to authorize the key:");
console.log(`  ${data.validationUrl}`);
console.log("\nAfter authorizing, update your .envrc:");
console.log(`  OVH_CONSUMER_KEY=${data.consumerKey}`);
