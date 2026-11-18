# Production image for the API and the background worker (same image, different command).
# Node 24 LTS on Alpine; production dependencies only; runs as the unprivileged "node" user.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# The keyring lives in a mounted volume (/app/secrets), never in the image.
RUN mkdir -p /app/secrets && chown node:node /app/secrets
USER node

EXPOSE 8000
# /ready checks the database, not just the process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/ready').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.js"]
