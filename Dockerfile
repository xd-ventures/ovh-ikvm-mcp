# Stage 1 — Install production dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2 — Runtime
FROM oven/bun:1
WORKDIR /app

LABEL org.opencontainers.image.title="ovh-ikvm-mcp" \
      org.opencontainers.image.description="MCP server for bare metal iKVM/IPMI console access" \
      org.opencontainers.image.source="https://github.com/xd-ventures/ovh-ikvm-mcp" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:3001/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

USER app
ENTRYPOINT ["bun", "run", "src/index.ts"]
