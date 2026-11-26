FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json server.ts ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 3001

CMD ["npx", "tsx", "server.ts"]
