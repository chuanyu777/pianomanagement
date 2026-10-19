FROM node:24-bookworm-slim

WORKDIR /workspace
COPY . .
RUN npm install --include=dev \
    && npm run build -w @piano/assistant-protocol \
    && npm run build -w @piano/agent-runtime

ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "run", "start", "-w", "@piano/agent-runtime"]
