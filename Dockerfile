FROM node:20-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/client/dist ./client/dist
COPY server/ ./server/
COPY shared/ ./shared/

EXPOSE 3001

CMD ["node", "server/index.js"]
