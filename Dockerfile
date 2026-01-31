# 使用基于 Alpine 的轻量级 Node.js 镜像
FROM node:18-alpine

# --- 关键步骤 ---
# 安装系统级工具：unzip (解压zip), tar (解压tar.gz), ca-certificates (下载https)
# 你的 app.js 需要调用这些命令
RUN apk add --no-cache unzip tar ca-certificates

# 设置工作目录
WORKDIR /app

# 复制当前目录下的所有文件到容器内
COPY . .

# 创建运行目录并赋予权限
RUN mkdir -p sys_run && chmod 777 sys_run

# 暴露端口
EXPOSE 8352

# --- 启动命令 ---
# 这里直接把内存限制写死，防止 Docker 容器内存溢出
CMD ["node", "--max-old-space-size=32", "app.js"]
