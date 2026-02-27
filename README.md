# ovh-ikvm-mcp

[![CI](https://github.com/xd-ventures/ovh-ikvm-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/xd-ventures/ovh-ikvm-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

MCP server that gives LLMs visual access to bare metal server consoles via iKVM/IPMI. Capture screenshots of remote server screens for AI-powered debugging of bare metal deployments.

## Overview

This MCP (Model Context Protocol) server exposes bare metal server iKVM consoles as tools that LLMs can use. An LLM can list available servers and request screenshots of their console output — useful for debugging boot issues, kernel panics, network misconfigurations, and other problems visible on the server screen.

### How it works

```
LLM ──MCP──► ikvm-mcp server ──OVH API──► get viewer URL
                    │
                    ├──KVM WebSocket──► extract JPEG frame ──► PNG screenshot (AMI/ASRockRack BMC)
                    └──VNC/RFB over WebSocket──► capture framebuffer ──► PNG screenshot (standard VNC)
```

1. The MCP server authenticates with the cloud provider API (OVH)
2. Requests an iKVM/IPMI HTML5 console session
3. Establishes a BMC session (extracts session cookie and CSRF token from the viewer page)
4. Connects to the KVM WebSocket, receives JPEG video frames
5. Extracts the first complete JPEG frame and converts it to PNG
6. Returns the image to the LLM via MCP

### Supported providers

| Provider | Status |
|----------|--------|
| OVH      | Supported |

## MCP Tools

### `list_servers`

List all available bare metal servers with iKVM/IPMI access.

**Parameters:** none

**Returns:** JSON array of server objects:

```json
[
  {
    "id": "ns1234567.ip-1-2-3.eu",
    "name": "ns1234567.ip-1-2-3.eu",
    "provider": "ovh",
    "datacenter": "sbg3",
    "ip": "1.2.3.4"
  }
]
```

### `get_screenshot`

Capture a screenshot of a server's iKVM/IPMI console screen. Returns a PNG image optimized for LLM vision (2x upscale + brightness boost). Set `raw=true` to get the original unprocessed image.

**Parameters:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `serverId` | string | *(required)* | Server identifier (e.g., `ns1234567.ip-1-2-3.eu`) |
| `raw` | boolean | `false` | Return the raw screenshot without LLM optimization |

**Returns:** PNG image content block (base64-encoded)

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- OVH API credentials (Application Key, Application Secret, Consumer Key)

### OVH API credentials

1. Create an application at https://eu.api.ovh.com/createApp/ (or your region's equivalent: `ca.api.ovh.com`, `api.us.ovhcloud.com`)
2. Note the **Application Key** and **Application Secret**
3. Request a consumer key with the required permissions:

```bash
curl -X POST https://eu.api.ovh.com/1.0/auth/credential \
  -H "X-Ovh-Application: YOUR_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accessRules": [
      { "method": "GET", "path": "/dedicated/server" },
      { "method": "GET", "path": "/dedicated/server/*" },
      { "method": "POST", "path": "/dedicated/server/*/features/ipmi/access" },
      { "method": "GET", "path": "/dedicated/server/*/features/ipmi/access" },
      { "method": "GET", "path": "/dedicated/server/*/task/*" }
    ]
  }'
```

4. The response includes a `consumerKey` and a `validationUrl` — open the URL in your browser to authorize the key

### Installation

```bash
git clone https://github.com/xd-ventures/ovh-ikvm-mcp.git
cd ovh-ikvm-mcp
bun install
```

### Configuration

Set the required environment variables:

```bash
export OVH_ENDPOINT="eu"                    # API region: eu, ca, or us
export OVH_APPLICATION_KEY="your-app-key"
export OVH_APPLICATION_SECRET="your-app-secret"
export OVH_CONSUMER_KEY="your-consumer-key"
```

### Running

```bash
bun start
```

The server starts on `http://localhost:3001/mcp` by default.

### Using with AI Coding Agents

The server uses **Streamable HTTP** transport (not stdio), so all agents connect to it over HTTP. Start the server first, then configure your agent to point at it.

**1. Start the server:**

```bash
cd ovh-ikvm-mcp
export OVH_ENDPOINT="eu"
export OVH_APPLICATION_KEY="your-app-key"
export OVH_APPLICATION_SECRET="your-app-secret"
export OVH_CONSUMER_KEY="your-consumer-key"
bun start
```

You should see: `ikvm-mcp server listening on http://localhost:3001/mcp`

**2. Configure your agent** (pick one):

---

#### Claude Code

Register via the CLI:

```bash
claude mcp add ikvm --transport http http://localhost:3001/mcp
```

Or add to your project's `.mcp.json` so teammates get it automatically:

```json
{
  "mcpServers": {
    "ikvm": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Verify it's connected:

```bash
claude mcp list
```

Make sure the OVH environment variables are set in the terminal where you run `bun start`.

---

#### Claude Desktop

Add to your Claude Desktop MCP config:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ikvm": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

After saving, restart Claude Desktop. The hammer icon in the input box confirms the MCP tools are loaded.

---

#### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` for global):

```json
{
  "mcpServers": {
    "ikvm": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

After saving, open Cursor Settings > MCP and verify the `ikvm` server shows a green indicator.

---

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ikvm": {
      "serverUrl": "http://localhost:3001/mcp"
    }
  }
}
```

---

### Example Prompts

Once connected, you can use these prompts with any agent:

**List servers and take a screenshot:**

```
List my bare metal servers using the ikvm MCP, then take a screenshot
of the first server's console. Describe what you see on the screen.
```

**Debug a server that won't boot:**

```
My server ns1234567.ip-1-2-3.eu is stuck during boot. Take a screenshot
of its console and diagnose the issue. If you see a kernel panic or
GRUB error, suggest how to fix it.
```

**Monitor server state:**

```
Take a screenshot of ns1234567.ip-1-2-3.eu console. Is the server
at a login prompt, showing an error, or still booting? If it's at
a login prompt, the OS reinstall was successful.
```

**Compare raw vs optimized output:**

```
Take two screenshots of ns1234567.ip-1-2-3.eu — one default (optimized)
and one with raw=true. Compare the readability.
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run with watch mode
bun run dev

# Type check
bun run typecheck

# Lint
bun run lint

# Lint and auto-fix
bun run lint:fix

# Format
bun run format
```

### Testing

Tests use Bun's built-in test runner with:

- **Mock BMC server** — simulates ASRockRack/AMI BMC with session auth and JPEG frame WebSocket
- **Test VNC server** — minimal RFB server serving a known image for VNC client tests
- **Mock OVH API** — simulates OVH REST API endpoints with auth validation
- **In-memory MCP transport** — tests MCP tool invocation without HTTP overhead

Run the full verification suite:

```bash
bun run typecheck && bun run lint && bun test
```

## Architecture

```
src/
├── index.ts              # Entry point — Bun HTTP server with MCP transport
├── kvm/
│   ├── types.ts          # KVM/BMC session types
│   ├── bmc-session.ts    # BMC session establishment (cookie + CSRF extraction)
│   ├── screenshot.ts     # KVM screenshot: IVTP WebSocket → AST2500 decode → PNG
│   ├── optimize.ts       # LLM vision optimization (2x upscale + brightness boost)
│   └── decoder-fetcher.ts # Runtime fetcher for AST2500 decoder from BMC
├── vnc/
│   ├── rfb-client.ts     # VNC/RFB protocol client over WebSocket
│   ├── encodings.ts      # RFB framebuffer encoding decoders (Raw, CopyRect)
│   ├── types.ts          # RFB protocol types and constants
│   └── screenshot.ts     # High-level: connect → capture → PNG encode
├── providers/
│   ├── types.ts          # Provider interface (listServers, getScreenshot)
│   └── ovh/
│       ├── api.ts        # OVH API client with request signing
│       ├── provider.ts   # OVH provider implementation
│       └── types.ts      # OVH-specific types
└── mcp/
    └── server.ts         # MCP server setup + tool definitions
```

### Provider interface

Adding a new provider means implementing the `Provider` interface:

```typescript
interface Provider {
  name: string;
  listServers(): Promise<Server[]>;
  getScreenshot(serverId: string): Promise<Buffer>;
}
```

### AMI KVM client

OVH servers use ASRockRack/AMI BMC firmware with a proprietary WebSocket KVM protocol at `wss://<host>/kvm`. The KVM client:

1. Fetches the viewer redirect page and extracts the `QSESSIONID` cookie and `garc` CSRF token
2. Connects to the KVM WebSocket endpoint
3. Scans incoming binary messages for JPEG SOI (`0xFFD8`) / EOI (`0xFFD9`) markers
4. Extracts the first complete JPEG frame and converts it to PNG

### VNC/RFB client

The VNC client connects directly to the WebSocket endpoint exposed by iKVM viewers that use standard VNC, performing the RFB protocol handshake (version negotiation, security, framebuffer request) without needing a headless browser.

Supported RFB features:
- Protocol versions: 3.3, 3.7, 3.8
- Security: None, VNC Authentication (DES challenge-response)
- Encodings: Raw, CopyRect

## Acknowledgments

This project connects to BMC firmware by [American Megatrends Inc. (AMI)](https://www.ami.com/).
The AST2500 video decoder is fetched at runtime from the BMC's web interface
and is not distributed with this project. See [NOTICE](NOTICE) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, workflow, and guidelines.

This project follows the [Contributor Covenant 3.0](CODE_OF_CONDUCT.md) code of conduct.

To report security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
