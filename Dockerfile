# Use official Microsoft Playwright image (includes Node, dependencies, and Chromium)
FROM mcr.microsoft.com/playwright:v1.45.0-noble

WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]