# syntax=docker/dockerfile:1

# ----- deps -----
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 在 slim 镜像里找不到 prebuilt,需要 fallback 到 node-gyp,
# 因此提前安装 python3 / 编译工具链。runner 镜像不继承这一层,不会变大。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# 只先拷贝依赖清单,利于 Docker layer cache。
COPY package.json package-lock.json ./

# 安装全部依赖。
# grammY 会带 node-fetch,但项目运行时已通过 client.fetch 使用 native fetch。
RUN npm ci

# ----- builder -----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建 Next.js。
# next.config.js 已配置 encoding fallback，解决 node-fetch optional dependency warning。
RUN npm run build

# ----- runner -----
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# 非 root 用户运行，降低容器风险。
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Next.js 未启用 standalone,这里复制非 standalone 模式所需运行文件。
# 项目当前没有 public/ 目录,直接 COPY 会报 "not found",这里在 runner 里
# 主动创建一个空目录,等将来真的放入静态资源时再恢复 COPY。
RUN mkdir -p ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

USER nextjs

EXPOSE 3000

CMD ["npx", "next", "start"]
