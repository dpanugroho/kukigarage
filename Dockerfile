FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

COPY . .

RUN mkdir -p /data/uploads

EXPOSE 3000

CMD ["bun", "run", "server.ts"]
