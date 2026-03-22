FROM eclipse-temurin:21-jdk-jammy

# Install Node.js 22
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
