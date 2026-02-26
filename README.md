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
3. Connects directly to the VNC/RFB WebSocket endpoint
4. Captures the framebuffer and encodes it as PNG
5. Returns the image to the LLM via MCP

### Supported providers

| Provider | Status |
|----------|--------|
| OVH      | In progress |

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_servers` | List all available bare metal servers |
| `get_screenshot` | Capture a screenshot of a server's iKVM console |

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- OVH API credentials (Application Key, Application Secret, Consumer Key)

### OVH API credentials

1. Create an application at https://eu.api.ovh.com/createApp/ (or your region's equivalent)
2. Request a consumer key with these permissions:
   - `GET /dedicated/server`
   - `GET /dedicated/server/*/features/ipmi*`
   - `POST /dedicated/server/*/features/ipmi*`
   - `GET /dedicated/server/*/task/*`

### Installation

```bash
bun install
```

### MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop):

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

### Running

```bash
bun start
```

## Development

```bash
# Run tests
bun test

# Run with watch mode
bun run dev

# Type check
bun run typecheck

# Lint
bun run lint

# Lint and fix
bun run lint:fix
```

## Architecture

```
src/
├── index.ts              # Entry point — starts MCP server
├── vnc/
│   ├── rfb-client.ts     # VNC/RFB protocol client over WebSocket
│   ├── encodings.ts      # RFB framebuffer encoding decoders
│   ├── types.ts          # RFB protocol types
│   └── screenshot.ts     # High-level screenshot capture
├── providers/
│   ├── types.ts          # Provider interface
│   └── ovh/
│       ├── api.ts        # OVH API client (auth + signing)
│       ├── provider.ts   # OVH provider implementation
│       └── types.ts      # OVH-specific types
└── mcp/
    ├── server.ts         # MCP server setup
    └── tools.ts          # Tool handlers
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
