FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY *.html *.js *.css ./
RUN mkdir -p /data /data/whatsapp-session
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/pilot.json
EXPOSE 3000
CMD ["node","server/index.js"]
