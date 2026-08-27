FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src
COPY tests ./tests
COPY tsconfig*.json vitest.config.ts .env.example README.md ./
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/src ./src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.env.example ./
EXPOSE 3000 4173
CMD ["node", "apps/api/dist/main.js"]
