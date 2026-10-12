# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/prompts ./prompts
COPY package.json next.config.ts ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start"]
