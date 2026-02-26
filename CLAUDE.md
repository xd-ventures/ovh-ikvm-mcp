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

### Git Workflow — MANDATORY for every feature/fix

**Every new feature or fix MUST follow this flow. No exceptions.**

1. **Create a feature branch** from `main`:
   ```bash
   git checkout main && git pull
   git checkout -b feat/<name>   # or fix/<name>, test/<name>
   ```

2. **Develop on the branch** using BDD (write test → implement → refactor). Make conventional commits:
   - `feat:`, `fix:`, `test:`, `chore:`, `docs:`

3. **Verify before PR** — all three must pass:
   ```bash
   bun run typecheck && bun run lint && bun test
   ```

4. **Push and create a PR** via `gh`:
   ```bash
   git push -u origin feat/<name>
   gh pr create --title "feat: ..." --body "..."
   ```

5. **PR review by Staff TypeScript agent** — spawn a `Plan` sub-agent (or equivalent reviewer agent) acting as a **staff TypeScript engineer**. The reviewer must check:
   - Type safety and correct use of TypeScript
   - Test coverage and quality
   - Error handling
   - Code clarity and simplicity
   - No unnecessary abstractions
   - The reviewer may request changes. Apply them, push, and re-request review.

6. **Merge only after reviewer approval** and CI passing:
   ```bash
   gh pr merge <number> --squash
   ```

7. **Switch back to main**:
   ```bash
   git checkout main && git pull
   ```

**Do NOT skip steps.** Do not merge without review. Do not commit directly to `main`.

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
- **AMI KVM for OVH**: OVH BMCs use ASRockRack/AMI firmware with a proprietary IVTP WebSocket protocol (`wss://<host>/kvm`), not standard VNC
- **LLM-optimized output**: `get_screenshot` returns 2x upscaled + 3x brightness-boosted PNGs by default (raw BMC output is too small/dark for LLM vision); `raw=true` gives the original
- **MCP tools return image content**: Screenshots are returned as base64 PNG in MCP image blocks
- **No headless browser**: Direct WebSocket connection for screenshot capture
- **Read-only MVP**: Only screenshot capture, no keyboard/mouse input (yet)

## Key Files

- `src/kvm/screenshot.ts` — AMI KVM screenshot: IVTP WebSocket → AST2500 decode → PNG
- `src/kvm/bmc-session.ts` — BMC session establishment (cookie + CSRF + KVM token)
- `src/kvm/optimize.ts` — LLM vision optimization (upscale + brightness boost)
- `src/kvm/vendor/decode_worker.js` — Vendored AST2500 video decoder from AMI firmware (no types)
- `src/vnc/rfb-client.ts` — VNC/RFB protocol client (for future standard VNC providers)
- `src/providers/types.ts` — Provider interface definition
- `src/providers/ovh/api.ts` — OVH API client with request signing
- `src/mcp/server.ts` — MCP server and tool registration
- `src/index.ts` — Entry point

## Lessons Learned

- **LLM vision needs post-processing**: Raw BMC screenshots (800x600, dark) render as tiny thumbnails in Claude's vision. A 2x nearest-neighbor upscale + 3x brightness boost makes text perfectly readable. Always optimize by default; offer `raw` flag for debugging.
- **AST2500 decoder is non-strict JS**: The vendored `decode_worker.js` uses `delete` on variables and other non-strict patterns. It must be loaded via `new Function()`, not `import`. No TypeScript types exist for it.
