FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/aethelgard.sqlite
EXPOSE 3000

USER node
CMD ["npm", "start"]
