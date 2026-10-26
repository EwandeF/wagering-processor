FROM oven/bun:1.4.4

WORKDIR /app

# Dependências primeiro: a camada só é refeita quando package.json ou bun.lock mudam.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
USER bun

CMD ["bun", "run", "src/main.ts"]
