# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# 非 root 用户
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# 服务端配置存储目录（源列表、订阅、观影历史、播放进度）。
# 必须建好并把属主给运行用户：named volume 首次挂载会继承镜像里的权限，
# 不预先 chown 的话非 root 进程建不了目录，配置就只能存在浏览器里。
RUN mkdir -p /data && chown nextjs:nodejs /data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

ENV DATA_DIR=/data

# 声明卷，提醒部署者这是一个需要持久化的路径。
# 注意 VOLUME 本身不保证宿主机路径固定（匿名卷会随容器删除），
# 生产环境仍应显式映射宿主目录。
VOLUME ["/data"]

USER nextjs

EXPOSE 8080
CMD ["node", "server.js"]
