FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp-kit/package.json packages/mcp-kit/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/notes-mcp/package.json apps/notes-mcp/
COPY apps/fx-mcp/package.json apps/fx-mcp/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY . .
RUN npm run build -w @urumi/dashboard && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/woo-mcp/src ./apps/woo-mcp/src
COPY --from=build /app/apps/woo-mcp/package.json ./apps/woo-mcp/
COPY --from=build /app/apps/notes-mcp/src ./apps/notes-mcp/src
COPY --from=build /app/apps/notes-mcp/package.json ./apps/notes-mcp/
COPY --from=build /app/apps/fx-mcp/src ./apps/fx-mcp/src
COPY --from=build /app/apps/fx-mcp/package.json ./apps/fx-mcp/
COPY --from=build /app/apps/gateway/src ./apps/gateway/src
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
USER 1000:1000
EXPOSE 8000 8080
CMD ["node", "apps/gateway/src/main.ts"]
