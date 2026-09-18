FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY api ./api
COPY client ./client
COPY index.html ./
RUN mkdir -p /data
ENV NODE_ENV=production PORT=3000 PGLITE_DIR=/data/pglite
EXPOSE 3000
CMD ["node", "server/index.js"]
