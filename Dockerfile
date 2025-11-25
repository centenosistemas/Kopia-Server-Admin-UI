FROM node:20-alpine

RUN apk update && apk add --no-cache docker-cli && apk add expect

WORKDIR /app

COPY ./js/package.json /app/package.json
RUN npm install

COPY ./js/index.js /app/index.js

CMD ["node", "index.js"]
