FROM eclipse-temurin:21-jdk-jammy

# Install Node.js 22 + Gradle
RUN apt-get update && apt-get install -y curl unzip && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    curl -fsSL https://services.gradle.org/distributions/gradle-8.11-bin.zip -o /tmp/gradle.zip && \
    unzip /tmp/gradle.zip -d /opt && \
    rm /tmp/gradle.zip && \
    ln -s /opt/gradle-8.11/bin/gradle /usr/local/bin/gradle && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
