# Troubleshooting & Development Guide

This guide documents the AMI/ASRockRack BMC reverse-engineering techniques used to build this project. Useful when debugging connectivity issues or extending to new BMC firmware versions.

## BMC Session Flow

The full authentication and screenshot pipeline:

```
OVH API ──► viewer URL (with ?token=QSESSIONID)
     │
     ├── 1. Fetch viewer page (redirect: "manual")
     │       → Extract QSESSIONID cookie (Set-Cookie header or URL ?token= param)
     │       → Extract garc CSRF token from embedded JS
     │
     ├── 2. Fetch /viewer.html with Cookie: QSESSIONID=...
     │       → Activates the session on the BMC
     │
     ├── 3. POST /api/kvm/token with Cookie + X-CSRFTOKEN headers
     │       → Returns { client_ip, token, session }
     │       → token is one-time-use — must connect WebSocket immediately
     │
     └── 4. Connect wss://<host>/kvm with Cookie + Origin headers
             → IVTP protocol handshake (see below)
             → Receive AST2500 compressed video frame
             → Decode → PNG
```

## IVTP Protocol Reference

The AMI BMC uses IVTP (Intelligent Video Transport Protocol) over WebSocket at `/kvm`.

### Packet format

Every IVTP message has an 8-byte header:

```
Offset  Size  Field
0       2     type     (uint16 LE) — command type
2       4     pktsize  (uint32 LE) — payload size after header
6       2     status   (uint16 LE) — status/flags
```

### Handshake sequence

```
Client                              BMC Server
  │                                    │
  │◄── CMD_CONNECTION_ALLOWED (0x17) ──│  "you may authenticate"
  │                                    │
  │── CMD_CONNECTION_COMPLETE (0x3a) ──►│  status=1
  │── CMD_VALIDATE_VIDEO_SESSION ──────►│  type=0x12, 373-byte auth payload
  │── CMD_RESUME_REDIRECTION (0x06) ──►│  status=0
  │                                    │
  │◄── CMD_VALIDATED_SESSION (0x13) ───│  payload[0]: 1=ok, 0=invalid
  │                                    │
  │── CMD_POWER_STATUS (0x22) ────────►│  request power state
  │◄── CMD_POWER_STATUS (0x22) ────────│  status: 1=ON, 0=OFF
  │                                    │
  │── CMD_RESUME_REDIRECTION (0x06) ──►│
  │── CMD_GET_FULL_SCREEN (0x0b) ─────►│  request full frame
  │                                    │
  │◄── CMD_VIDEO_PACKETS (0x19) ───────│  first: frag(2) + header(86) + data
  │◄── CMD_VIDEO_PACKETS (0x19) ───────│  subsequent: frag(2) + data
  │◄── ... (until compressSize reached) │
```

### Auth payload structure (373 bytes)

```
Offset  Size  Field
0       1     flag              (0 = first connection)
1       129   ssi_hash          (KVM token from /api/kvm/token, null-terminated)
130     65    client_ip         (from /api/kvm/token response)
195     129   username          ("domain/username", null-terminated)
324     49    mac_address       ("00-00-00-00-00-00", null-terminated)
```

### Video frame header (86 bytes, AST2500 format)

```
Offset  Size  Field
0       2     iEngineVersion
2       2     wHeaderLen (= 86)
4       2     Source.X (width)
6       2     Source.Y (height)
...
42      1     CompressionMode
43      1     JPEGScaleFactor
44      1     JPEGTableSelector
45      1     JPEGYUVTableMapping
49      4     NumberOfMB
53      1     RC4Enable
55      1     Mode420
69      4     CompressData.CompressSize   ← total compressed bytes to expect
```

## Debugging Techniques

### Discovering BMC API endpoints

Fetch the BMC's `source.min.js` and search for API routes:

```typescript
const res = await fetch(`https://${host}/source.min.js`, {
  headers: { Cookie: `QSESSIONID=${cookie}` },
});
const js = await res.text();

// Extract all API paths
const apiRe = /["']\/api\/[^"']+["']/g;
const apis = new Set<string>();
let m;
while ((m = apiRe.exec(js)) !== null) {
  apis.add(m[0].replace(/['"]/g, ""));
}
console.log([...apis].sort().join("\n"));
```

Known KVM-relevant endpoints:
- `/api/kvm/token` — one-time KVM auth token
- `/api/kvm/instances` — active KVM sessions
- `/api/settings/media/kvm` — KVM settings

### Extracting IVTP constants from firmware

The protocol constants live in `/libs/kvm/videosocket.js`:

```typescript
const res = await fetch(`https://${host}/libs/kvm/videosocket.js`, {
  headers: { Cookie: `QSESSIONID=${cookie}` },
});
const js = await res.text();

// Find IVTP constant block
const ivtpIdx = js.indexOf("IVTP");
const blockStart = js.lastIndexOf("var ", ivtpIdx);
console.log(js.substring(blockStart, blockStart + 2000));
```

### Fetching BMC decoder libraries

The AST2500 video decoder and supporting libraries:

```typescript
const files = [
  "/libs/kvm/ast/decode_worker.js",     // AST2500 tile decoder
  "/libs/kvm/ast/ast_jpeg_decoder.js",   // JPEG table decoder
  "/libs/kvm/videosocket.js",            // IVTP protocol handler
  "/libs/kvm/ivtp.js",                   // IVTP constants
];

for (const file of files) {
  const res = await fetch(`https://${host}${file}`, {
    headers: { Cookie: `QSESSIONID=${cookie}` },
  });
  if (res.status === 200) {
    const text = await res.text();
    console.log(`${file}: ${text.length} bytes`);
  }
}
```

### Finding WebSocket endpoints

Search firmware JS for WebSocket usage patterns:

```typescript
const js = await (await fetch(`https://${host}/source.min.js`, {
  headers: { Cookie: `QSESSIONID=${cookie}` },
})).text();

for (const term of ["wss:", "ws:", ".onopen", ".onmessage", "kvm", "Socket"]) {
  const idx = js.indexOf(term);
  if (idx >= 0) {
    console.log(`"${term}" at ${idx}: ${js.substring(idx - 100, idx + 100)}`);
  }
}
```

### Finding KVM token lifecycle

The viewer page populates `sessionStorage.token` from `/api/kvm/token`. Search for the flow:

```typescript
// Search source.min.js for token handling
let idx = 0;
while ((idx = js.indexOf("sessionStorage", idx)) >= 0) {
  const ctx = js.substring(idx, idx + 150);
  if (ctx.includes("token")) {
    console.log(`[sessionStorage+token at ${idx}]: ${ctx}`);
  }
  idx += 14;
}
```

## Common Issues

### "Failed to extract QSESSIONID"

The viewer URL may have changed format. Check:
1. Does the URL contain a `?token=` query parameter? (newer format)
2. Does the response include a `Set-Cookie: QSESSIONID=` header?
3. Does the HTML body contain `document.cookie = "QSESSIONID=..."`?

### "KVM session validation failed (code: 0)"

The KVM token is one-time-use. Each call to `/api/kvm/token` generates a new one. If you called it twice, the first token is invalidated. Ensure you connect the WebSocket immediately after obtaining the token.

### WebSocket closes immediately

Check that:
- The `Cookie: QSESSIONID=...` header is sent on the WebSocket upgrade
- The `Origin: https://<host>` header matches the BMC hostname
- The session hasn't expired (OVH viewer URLs have a TTL, typically 15 minutes)

### AST2500 decoder errors

The vendored `decode_worker.js` uses non-strict JavaScript (`delete` on variables, etc.). It must be loaded via `new Function()`, not `import`. See `src/kvm/screenshot.ts:getDecoder()` for the loading pattern.

## Live Testing

Run the live integration test (requires OVH credentials):

```bash
export OVH_ENDPOINT="eu"
export OVH_APPLICATION_KEY="..."
export OVH_APPLICATION_SECRET="..."
export OVH_CONSUMER_KEY="..."
bun test test/integration/mcp-live.test.ts
```

Run the KVM probe script for quick connectivity debugging:

```bash
bun run scripts/probe-kvm.ts
```
