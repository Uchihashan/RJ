FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node
CMD ["node", "dist/index.js"]