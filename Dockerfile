# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json yarn.lock ./
COPY src ./src
RUN addgroup -S -g 1001 agentmail && adduser -S -u 1001 -G agentmail agentmail && mkdir /data && chown agentmail:agentmail /data
USER agentmail
ENTRYPOINT ["node", "src/mcp/server.mjs"]
