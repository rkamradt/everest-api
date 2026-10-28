FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY bin/ ./bin/
COPY seed/ ./seed/
COPY docs/ ./docs/
EXPOSE 8080
CMD ["node", "src/app.js"]
