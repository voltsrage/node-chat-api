FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy pre-built node_modules from the deps stage — no npm install needed here
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 3090

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3090/health || exit 1

CMD ["node", "src/index.js"]