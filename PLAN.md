# ovh-ikvm-mcp — Detailed Implementation Plan

## Project Overview

An MCP (Model Context Protocol) server that gives LLMs read-only visual access to bare metal server consoles via iKVM/IPMI. The primary use case is debugging bare metal deployments — an LLM can request a screenshot of a server's console screen and reason about what it sees.

**MVP scope**: Given a server identifier, return a screenshot (as image data) of its iKVM console.
**Initial provider**: OVH (other providers can be added later).
**Transport**: Streamable HTTP.
**Runtime**: Bun + TypeScript.
**License**: Apache 2.0.

---

## Architecture

```
┌─────────────┐     HTTP/SSE      ┌──────────────────┐
│  LLM Client │ ◄──────────────► │  MCP Server       │
│  (Claude,   │   MCP Protocol    │  (Bun + TS)       │
│   etc.)     │                   │                   │
└─────────────┘                   │  Tools:           │
                                  │  - list_servers   │
                                  │  - get_screenshot │
                                  └────────┬──────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                          ▼                ▼                ▼
                   ┌─────────────┐  ┌───────────┐   ┌───────────┐
                   │ OVH Provider│  │ Future     │   │ Future    │
                   │             │  │ Provider B │   │ Provider C│
                   └──────┬──────┘  └───────────┘   └───────────┘
                          │
              ┌───────────┼───────────┐
              ▼                       ▼
       ┌─────────────┐        ┌──────────────┐
       │ OVH API     │        │ VNC/RFB      │
       │ (list, get  │        │ Client       │
       │  viewer URL)│        │ (websocket   │
       └─────────────┘        │  → framebuf) │
                              └──────────────┘
```

### Key Design Decisions

1. **Provider interface**: A simple `Provider` interface with `listServers()` and `getScreenshot(serverId)`. OVH is the first implementation. Adding Hetzner, Vultr, etc. later means implementing this interface.

2. **Two-layer screenshot capture**:
   - **Layer 1 (h5viewer/VNC)**: A VNC/RFB client that connects via WebSocket to the iKVM viewer endpoint, performs the RFB handshake, requests a framebuffer update, and captures the frame as a PNG. This is the core reusable component.
   - **Layer 2 (OVH API)**: Authenticates with OVH, requests an iKVM HTML5 session URL, extracts the WebSocket endpoint from the viewer page, then hands it to Layer 1.

3. **No headless browser**: Instead of Puppeteer/Playwright (heavy, flaky with canvas), we connect directly to the VNC WebSocket. The h5viewer page is just a noVNC-style HTML5 app — the real data flows over WebSocket using the RFB protocol. We can implement a minimal RFB client in TypeScript that:
   - Connects to the WebSocket endpoint
   - Performs RFB version negotiation + auth
   - Sends FramebufferUpdateRequest
   - Receives framebuffer data
   - Encodes it as PNG

4. **MCP tool returns image content**: The `get_screenshot` tool returns an MCP image content block (base64 PNG), which LLMs can directly interpret.

---

## Phase 1: h5viewer / VNC Framebuffer Capture

This phase is about building a standalone VNC screenshot client that can connect to any h5viewer/noVNC WebSocket endpoint and capture a frame. **Testable end-to-end locally** using a local VNC server.

### Step 1.0: Project Scaffolding

**Files to create:**

```
ovh-ikvm-mcp/
├── README.md                  # Project overview, setup, usage
├── CLAUDE.md                  # AI coding guidelines, BDD approach, testing conventions
├── LICENSE                    # Apache 2.0
├── package.json               # Bun project config
├── tsconfig.json              # TypeScript config (strict)
├── biome.json                 # Linter/formatter config
├── .github/
│   └── workflows/
│       └── ci.yml             # GitHub Actions: lint, typecheck, test
├── .gitignore
├── src/
│   ├── index.ts               # MCP server entry point (placeholder)
│   ├── vnc/
│   │   ├── rfb-client.ts      # RFB protocol client (WebSocket → framebuffer)
│   │   ├── encodings.ts       # RFB encoding decoders (Raw, CopyRect, minimal set)
│   │   ├── types.ts           # RFB protocol types
│   │   └── screenshot.ts      # High-level: connect → capture → return PNG buffer
│   ├── providers/
│   │   ├── types.ts           # Provider interface definition
│   │   └── ovh/
│   │       ├── api.ts         # OVH API client (auth, signing, endpoints)
│   │       ├── provider.ts    # OVH provider implementation
│   │       └── types.ts       # OVH-specific types
│   └── mcp/
│       ├── server.ts          # MCP server setup + tool definitions
│       └── tools.ts           # Tool handlers (list_servers, get_screenshot)
└── test/
    ├── helpers/
    │   └── vnc-server.ts      # Minimal VNC server for testing (serves a test image)
    ├── vnc/
    │   ├── rfb-client.test.ts # RFB client unit tests
    │   └── screenshot.test.ts # Screenshot integration test (uses local VNC server)
    └── providers/
        └── ovh/
            └── api.test.ts    # OVH API client tests (mocked HTTP)
```

**package.json dependencies:**
- `@modelcontextprotocol/sdk` — MCP server SDK
- `sharp` or `pngjs` — PNG encoding from raw pixel data
- `ws` (or use Bun's native WebSocket) — WebSocket client

**Dev dependencies:**
- `typescript`
- `@types/bun`
- `biome` — lint/format

**CLAUDE.md contents** (key sections):
- BDD approach: write failing test → implement → pass
- Use `bun test` for all testing
- Use `bun:test` (Bun's built-in test runner, Jest-compatible API)
- Prefer `describe`/`it`/`expect` style
- TypeScript strict mode, no `any` unless absolutely necessary
- Feature branches, PRs reviewed via `gh` CLI
- Iterative development: each feature = branch → tests → implementation → PR → review → merge

### Step 1.1: RFB Protocol Types

Define TypeScript types for the RFB/VNC protocol:

- `RfbVersion` — protocol version (3.3, 3.7, 3.8)
- `SecurityType` — None(1), VNCAuth(2), etc.
- `PixelFormat` — bits-per-pixel, depth, big-endian, true-color, RGB max/shift
- `FramebufferUpdate` — list of rectangles with encoding-specific data
- `Rectangle` — x, y, width, height, encoding, pixel data
- `ClientMessage` / `ServerMessage` enums

### Step 1.2: Minimal RFB Client

Implement `RfbClient` class:

```typescript
class RfbClient {
  constructor(wsUrl: string, options?: { password?: string })

  connect(): Promise<void>           // WebSocket connect + RFB handshake
  requestFramebuffer(): Promise<void> // Send FramebufferUpdateRequest (full)
  getFramebuffer(): Promise<{        // Wait for and return framebuffer data
    width: number
    height: number
    pixels: Uint8Array               // Raw RGBA pixel data
  }>
  disconnect(): void
}
```

RFB handshake flow:
1. Server sends version string (`RFB 003.008\n`)
2. Client responds with matching version
3. Server sends security types
4. Client selects security type (None or VNCAuth)
5. If VNCAuth: server sends 16-byte challenge, client responds with DES-encrypted response
6. Server sends SecurityResult
7. Client sends ClientInit (shared flag)
8. Server sends ServerInit (width, height, pixel format, name)
9. Client sends SetPixelFormat (request RGBA or RGB)
10. Client sends SetEncodings (Raw + CopyRect minimum)
11. Client sends FramebufferUpdateRequest (incremental=0 for full frame)
12. Server sends FramebufferUpdate with rectangles

**Encoding support (minimum viable):**
- **Raw** (encoding 0) — uncompressed pixel data, simplest to implement
- **CopyRect** (encoding 1) — reference to already-received region

For iKVM/IPMI BMCs, Raw encoding is almost always supported and is sufficient for single-frame capture.

### Step 1.3: PNG Encoding

Convert raw pixel buffer to PNG:
- Use `pngjs` or `sharp` to encode `{width, height, pixels: Uint8Array}` → PNG `Buffer`
- Keep it simple — no compression tuning needed

### Step 1.4: Screenshot Module

High-level `captureScreenshot(wsUrl, options?)` function:
1. Create `RfbClient` with WebSocket URL
2. Connect and handshake
3. Request full framebuffer
4. Receive framebuffer data
5. Encode as PNG
6. Disconnect
7. Return PNG buffer

### Step 1.5: Local VNC Test Server

For BDD testing, create a minimal VNC server in `test/helpers/vnc-server.ts`:
- Listens on a local port
- Implements server side of RFB handshake (version, security=None, ServerInit)
- Serves a known test image (e.g., 800x600 solid color or checkerboard pattern)
- Responds to FramebufferUpdateRequest with the test image in Raw encoding
- Uses Bun's native WebSocket server or raw TCP + websockify

Alternatively, use a Docker-based VNC server (e.g., `x11vnc` + `websockify`) for integration tests — but a pure-TS test server is faster and more portable.

### Step 1.6: BDD Tests for Phase 1

```
Feature: VNC Screenshot Capture

  Scenario: Capture screenshot from a VNC server with no auth
    Given a VNC server running on ws://localhost:5901 with a 800x600 test image
    When I call captureScreenshot("ws://localhost:5901")
    Then I receive a valid PNG buffer
    And the PNG dimensions are 800x600

  Scenario: Capture screenshot from a VNC server with VNC auth
    Given a VNC server running with password "testpass"
    When I call captureScreenshot(url, { password: "testpass" })
    Then I receive a valid PNG buffer

  Scenario: Connection timeout
    Given no VNC server is running
    When I call captureScreenshot("ws://localhost:59999")
    Then it throws a connection error within 5 seconds

  Scenario: Handle h5viewer-style WebSocket URL
    Given a WebSocket VNC proxy at ws://localhost:5901/websockify
    When I call captureScreenshot("ws://localhost:5901/websockify")
    Then I receive a valid PNG buffer
```

---

## Phase 2: OVH Provider + MCP Server

### Step 2.1: OVH API Client

Implement OVH API authentication and request signing:

```typescript
class OvhApiClient {
  constructor(config: {
    endpoint: string        // 'eu' | 'ca' | 'us'
    applicationKey: string
    applicationSecret: string
    consumerKey: string
  })

  get<T>(path: string, params?: Record<string, string>): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
}
```

**Request signing** (per OVH docs):
```
Signature = "$1$" + SHA1(AS + "+" + CK + "+" + METHOD + "+" + URL + "+" + BODY + "+" + TIMESTAMP)
```

Headers on every request:
```
X-Ovh-Application: <AK>
X-Ovh-Consumer: <CK>
X-Ovh-Timestamp: <unix timestamp>
X-Ovh-Signature: <signature>
Content-Type: application/json
```

Time sync: fetch `/auth/time` once on init to compute delta.

### Step 2.2: OVH Provider Implementation

```typescript
interface Provider {
  listServers(): Promise<Server[]>
  getScreenshot(serverId: string): Promise<Buffer>  // PNG
}

interface Server {
  id: string
  name: string
  provider: string
  datacenter?: string
  ip?: string
}
```

OVH implementation:
1. `listServers()`:
   - `GET /dedicated/server` → list of service names
   - For each, `GET /dedicated/server/{name}` → details
   - Return normalized `Server[]`

2. `getScreenshot(serverId)`:
   - `POST /dedicated/server/{name}/features/ipmi/access` with `type=kvmipHtml5URL`, `ttl=15`, `ipToAllow=<server's public IP>`
   - Poll task completion
   - `GET /dedicated/server/{name}/features/ipmi/access?type=kvmipHtml5URL` → viewer URL
   - Parse viewer URL to extract WebSocket endpoint (fetch the viewer.html page, find the WS connection URL in the JavaScript/config)
   - Call `captureScreenshot(wsUrl)` from Phase 1
   - Return PNG buffer

**Viewer URL → WebSocket URL extraction:**
The viewer.html page (h5viewer) contains JavaScript that connects to a WebSocket. We need to:
- Fetch the viewer.html page
- Parse/extract the WebSocket URL from the page source or associated config
- The WS URL is likely on the same host, something like `wss://<session>.<dc>.ipmi.ovh.net/websockify` or similar
- This may require some reverse-engineering of the viewer page; we'll handle it adaptively

### Step 2.3: MCP Server with Streamable HTTP Transport

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({
  name: "ikvm-mcp",
  version: "0.1.0",
});

// Tool: list_servers
server.tool("list_servers", "List all available bare metal servers", {}, async () => {
  const servers = await provider.listServers();
  return { content: [{ type: "text", text: JSON.stringify(servers, null, 2) }] };
});

// Tool: get_screenshot
server.tool("get_screenshot", "Get a screenshot of a server's iKVM console",
  { serverId: z.string().describe("Server identifier") },
  async ({ serverId }) => {
    const png = await provider.getScreenshot(serverId);
    return {
      content: [{
        type: "image",
        data: png.toString("base64"),
        mimeType: "image/png",
      }]
    };
  }
);
```

### Step 2.4: Configuration via MCP Config

The server reads provider credentials from environment variables (set via MCP client config):

```json
{
  "mcpServers": {
    "ikvm": {
      "url": "http://localhost:3001/mcp",
      "env": {
        "OVH_ENDPOINT": "eu",
        "OVH_APPLICATION_KEY": "...",
        "OVH_APPLICATION_SECRET": "...",
        "OVH_CONSUMER_KEY": "..."
      }
    }
  }
}
```

### Step 2.5: BDD Tests for Phase 2

```
Feature: OVH API Client
  Scenario: Sign a GET request correctly
    Given OVH credentials (AK, AS, CK)
    When I sign a GET request to /dedicated/server
    Then the X-Ovh-Signature header matches the expected HMAC

  Scenario: List dedicated servers
    Given a mocked OVH API returning ["server1", "server2"]
    When I call listServers()
    Then I get 2 Server objects with correct names

Feature: MCP Server Tools
  Scenario: list_servers tool returns server list
    Given the MCP server is running with a mock provider
    When the client calls the list_servers tool
    Then it receives a text content block with server JSON

  Scenario: get_screenshot tool returns an image
    Given the MCP server is running with a mock provider
    And the mock provider returns a test PNG for "server1"
    When the client calls get_screenshot with serverId "server1"
    Then it receives an image content block with base64 PNG data
```

---

## Implementation Order (Step-by-Step)

### Milestone 0: Project Setup
- [ ] Initialize project (`bun init`)
- [ ] Create `package.json` with dependencies
- [ ] Create `tsconfig.json` (strict)
- [ ] Create `biome.json`
- [ ] Create `.gitignore`
- [ ] Create `LICENSE` (Apache 2.0)
- [ ] Create `README.md` (project overview, setup instructions, architecture)
- [ ] Create `CLAUDE.md` (development guidelines, BDD approach, testing conventions)
- [ ] Create `.github/workflows/ci.yml`
- [ ] Create initial directory structure (`src/`, `test/`)
- [ ] First commit + push

### Milestone 1: VNC/RFB Screenshot Client
- [ ] Define RFB protocol types (`src/vnc/types.ts`)
- [ ] Implement RFB client (`src/vnc/rfb-client.ts`)
- [ ] Implement Raw encoding decoder (`src/vnc/encodings.ts`)
- [ ] Implement PNG encoding (`src/vnc/screenshot.ts`)
- [ ] Build test VNC server (`test/helpers/vnc-server.ts`)
- [ ] Write and pass RFB client tests
- [ ] Write and pass screenshot integration tests
- [ ] PR → review → merge

### Milestone 2: OVH API Client
- [ ] Implement OVH API client with request signing (`src/providers/ovh/api.ts`)
- [ ] Define provider interface (`src/providers/types.ts`)
- [ ] Write OVH API client tests (mocked HTTP)
- [ ] PR → review → merge

### Milestone 3: OVH Provider (Viewer URL → Screenshot)
- [ ] Implement viewer URL extraction logic
- [ ] Implement OVH provider (`src/providers/ovh/provider.ts`)
- [ ] Write provider tests
- [ ] PR → review → merge

### Milestone 4: MCP Server
- [ ] Implement MCP server with tools (`src/mcp/server.ts`, `src/mcp/tools.ts`)
- [ ] Wire up provider to MCP tools
- [ ] Implement HTTP transport entry point (`src/index.ts`)
- [ ] Write MCP integration tests
- [ ] PR → review → merge

### Milestone 5: Polish & Release
- [ ] End-to-end manual test with real OVH server
- [ ] Update README with full usage docs
- [ ] Tag v0.1.0

---

## Git Workflow

- `main` — stable, passing CI
- Feature branches: `feat/<name>`, `fix/<name>`
- Each milestone = 1+ PRs
- PRs reviewed via `gh pr create` → sub-agent reviewer (acts as staff TS engineer) → `gh pr merge`
- Commit messages: conventional commits (`feat:`, `fix:`, `test:`, `chore:`)

---

## Key Technical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| h5viewer uses custom protocol, not standard VNC/RFB | Fetch viewer.html, reverse-engineer WS connection. Fallback: use Puppeteer if needed |
| BMC only supports complex RFB encodings (Tight, ZRLE) | Start with Raw. Most BMCs support Raw. If not, add Tight/ZRLE decoders |
| OVH viewer URL requires cookies/session beyond just WebSocket | Inspect viewer page, replicate any cookie/token setup |
| IP whitelist for IPMI access | Server auto-detects its own public IP and passes to `ipToAllow` |
| Rate limits on OVH API | Cache server lists, add retry with backoff |
| Bun WebSocket compatibility | Use Bun's native WebSocket. Fallback: `ws` package |

---

## Open Questions (to resolve during implementation)

1. **Viewer page structure**: What exact WebSocket URL does h5viewer connect to? Need to inspect a live viewer.html to extract the pattern. We'll handle this adaptively in Milestone 3.
2. **Authentication on the WebSocket**: Does the VNC/RFB connection use a password, or is auth handled at the HTTP/session level? The OVH viewer likely uses session tokens rather than VNC passwords.
3. **Pixel format from BMCs**: What pixel format do typical IPMI BMCs advertise? We'll adapt the PixelFormat negotiation based on what we see from real connections.
