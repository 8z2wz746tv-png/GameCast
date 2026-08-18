FROM node:22-alpine AS build

WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/src packages/contracts/src

RUN npm install --workspace @gamecast/server --include-workspace-root

COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
RUN npm run build -w @gamecast/server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /workspace/apps/server/package.json ./package.json
COPY --from=build /workspace/apps/server/dist ./dist
EXPOSE 8787
CMD ["node", "dist/index.js"]
