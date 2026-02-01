# TeleDigest Telegram Bot Docker镜像
# 老王出品，必属精品

FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量，防止Python生成.pyc文件和缓冲输出
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 安装系统依赖（如果需要的话）
RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目代码
COPY . .

# 创建数据目录（用于SQLite数据库持久化）
RUN mkdir -p /app/data

# 设置数据目录为volume挂载点
VOLUME ["/app/data"]

# 启动命令
CMD ["python", "-m", "TeleDigest"]
