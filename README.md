# ovh-ikvm-mcp

MCP server that gives LLMs visual access to bare metal server consoles via iKVM/IPMI. Capture screenshots of remote server screens for AI-powered debugging of bare metal deployments.

## Overview

This MCP (Model Context Protocol) server exposes bare metal server iKVM consoles as tools that LLMs can use. An LLM can list available servers and request screenshots of their console output — useful for debugging boot issues, kernel panics, network misconfigurations, and other problems visible on the server screen.

### How it works

```
LLM ──MCP──► ikvm-mcp server ──OVH API──► get viewer URL
                    │
                    └──VNC/RFB over WebSocket──► capture framebuffer ──► PNG screenshot
```

1. The MCP server authenticates with the cloud provider API (OVH)
2. Requests an iKVM/IPMI HTML5 console session
3. Connects directly to the VNC/RFB WebSocket endpoint (no headless browser needed)
4. Captures the framebuffer and encodes it as PNG
5. Returns the image to the LLM via MCP

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

Capture a screenshot of a server's iKVM/IPMI console screen. Returns a PNG image of what is currently displayed on the server's physical monitor output.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `serverId` | string | Server identifier (e.g., `ns1234567.ip-1-2-3.eu`) |

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

### MCP Client Configuration

#### Claude Desktop

Add to your Claude Desktop MCP config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ikvm": {
      "url": "http://localhost:3001/mcp",
      "env": {
        "OVH_ENDPOINT": "eu",
        "OVH_APPLICATION_KEY": "your-app-key",
        "OVH_APPLICATION_SECRET": "your-app-secret",
        "OVH_CONSUMER_KEY": "your-consumer-key"
      }
    }
  }
}
```

#### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "ikvm": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Make sure the environment variables are set in the shell where Claude Code runs.

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

### VNC/RFB client

The VNC client connects directly to the WebSocket endpoint exposed by the iKVM viewer, performing the RFB protocol handshake (version negotiation, security, framebuffer request) without needing a headless browser. This makes it lightweight and reliable.

Supported RFB features:
- Protocol versions: 3.3, 3.7, 3.8
- Security: None, VNC Authentication (DES challenge-response)
- Encodings: Raw, CopyRect

## License

Apache 2.0 — see [LICENSE](LICENSE).
