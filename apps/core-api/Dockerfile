FROM node:24-bookworm-slim

WORKDIR /workspace
COPY . .
RUN apt-get update \
    && apt-get install --no-install-recommends -y openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --include=dev \
    && npm run build -w @piano/assistant-protocol \
    && npm run db:generate -w @piano/core-api \
    && npm run build -w @piano/core-api

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@piano/core-api"]
