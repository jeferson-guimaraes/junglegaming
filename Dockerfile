# Imagem única da aplicação: toda réplica roda API, consumer SQS e workers.
FROM oven/bun:1.4.3-alpine

WORKDIR /app

# Dependências primeiro: a camada só é refeita quando o lockfile muda.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json bunfig.toml ./
COPY scripts ./scripts
COPY src ./src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun

CMD ["bun", "run", "src/main.ts"]
