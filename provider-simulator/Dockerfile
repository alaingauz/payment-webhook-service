FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY generator.js ./

RUN mkdir -p /app/data

EXPOSE 4000

CMD ["node", "server.js"]
