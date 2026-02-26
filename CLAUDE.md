# CLAUDE.md — Development Guidelines

## Project

ovh-ikvm-mcp — MCP server for bare metal iKVM/IPMI console access.
Runtime: Bun. Language: TypeScript (strict). License: Apache 2.0.

## Commands

```bash
bun test              # Run all tests
bun test --watch      # Run tests in watch mode
bun run typecheck     # TypeScript type checking
bun run lint          # Lint with Biome
bun run lint:fix      # Lint and auto-fix
bun run dev           # Run server with watch mode
bun start             # Run server
```

## Development Workflow

### BDD / Test-First Approach

Every feature is developed iteratively:

1. **Write a failing test** that describes the desired behavior
2. **Implement** the minimum code to make the test pass
3. **Refactor** if needed while keeping tests green
4. **Repeat** for the next behavior

### Git Workflow

- Branch from `main`: `feat/<name>`, `fix/<name>`, `test/<name>`
- Conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `docs:`
- PRs reviewed via `gh` CLI before merging
- CI must pass (typecheck + lint + test) before merge

### PR Review Process

PRs are reviewed by a dedicated reviewer sub-agent acting as a staff TypeScript engineer. The reviewer checks:
- Type safety and correct use of TypeScript
- Test coverage and quality
- Error handling
- Code clarity and simplicity
- No unnecessary abstractions

## Bun-Specific Best Practices

### Testing with `bun:test`

- Use `describe` / `it` / `expect` (Jest-compatible API)
- Test files: `test/**/*.test.ts` or `*.test.ts` anywhere
- Use `beforeAll` / `afterAll` for server setup/teardown in integration tests
- Bun's test runner is fast — don't hesitate to run the full suite often
- Use `expect().toEqual()` for deep equality, `toBe()` for reference equality

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

describe("feature", () => {
  it("should do the thing", () => {
    expect(result).toEqual(expected);
  });
});
```

### Bun APIs

- Prefer `Bun.serve()` for HTTP servers
- Use Bun's native `WebSocket` where possible
- Use `Bun.CryptoHasher` for SHA1/SHA256
- Use `Buffer` (available globally in Bun) for binary data
- `fetch` is globally available — no import needed

### TypeScript

- Strict mode — no `any` unless absolutely necessary (and add a comment why)
- Use explicit return types on exported functions
- Prefer `interface` over `type` for object shapes
- Use `readonly` on properties that shouldn't change
- Prefer `unknown` over `any` for untyped external data

## Architecture Principles

- **Provider pattern**: Each bare metal provider implements a `Provider` interface
- **Layered design**: VNC/RFB client is independent of any provider
- **MCP tools return image content**: Screenshots are returned as base64 PNG in MCP image blocks
- **No headless browser**: Direct VNC/RFB WebSocket connection for screenshot capture
- **Read-only MVP**: Only screenshot capture, no keyboard/mouse input (yet)

## Key Files

- `src/vnc/rfb-client.ts` — Core RFB protocol client
- `src/vnc/screenshot.ts` — High-level screenshot capture function
- `src/providers/types.ts` — Provider interface definition
- `src/providers/ovh/api.ts` — OVH API client with request signing
- `src/mcp/server.ts` — MCP server and tool registration
- `src/index.ts` — Entry point
