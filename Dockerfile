FROM mcr.microsoft.com/playwright:v1.45.0-noble

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]