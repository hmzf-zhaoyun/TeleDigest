# TeleDigest Telegram Bot Docker镜像
# 老王出品，必属精品
# 支持多平台构建：linux/amd64, linux/arm64

FROM python:3.11-slim

# 设置工作目录 - 注意这里改成 /app 作为父目录
WORKDIR /app

# 设置环境变量，防止Python生成.pyc文件和缓冲输出
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Asia/Shanghai

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    procps \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 安装 Playwright 浏览器和系统依赖
# 老王注：Playwright 需要先装系统依赖再装浏览器，顺序别搞反了
RUN playwright install-deps chromium \
    && playwright install chromium

# 关键修改：把代码复制到 TeleDigest 子目录，这样 python -m TeleDigest 才能找到模块
COPY . ./TeleDigest/

# 创建数据目录（用于SQLite数据库持久化）
RUN mkdir -p /app/TeleDigest/data

# 设置数据目录为volume挂载点
VOLUME ["/app/TeleDigest/data"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -f "python" || exit 1

# 启动命令 - 从 /app 目录运行，这样能找到 TeleDigest 模块
CMD ["python", "-m", "TeleDigest"]
