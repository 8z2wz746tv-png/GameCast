FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY apps/server/package.runtime.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY apps/server/dist ./dist

EXPOSE 8787
CMD ["node", "dist/index.js"]
