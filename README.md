# TeleDigest - Telegram 消息总结机器人

独立的 Telegram 机器人，提供定时消息读取与 AI 总结功能。

## 架构特点

- 🤖 **纯 Bot API**：使用 python-telegram-bot 库，无需 MTProto 客户端
- 💾 **本地存储**：消息存储到 SQLite 数据库
- ⏰ **定时总结**：使用 APScheduler 定时从数据库读取消息进行 AI 总结
- 🔐 **完全独立**：不依赖用户账号，不影响已读状态

## 功能特性

- 🕐 **定时消息总结**: 支持为每个群组独立配置定时任务
- 🤖 **多 LLM 支持**: 支持 OpenAI、Claude、Gemini 等多种 LLM API
- 🔐 **权限控制**: 仅机器人主人可执行管理命令
- 💾 **持久化存储**: 使用 SQLite 存储群组配置和消息
- 📊 **灵活调度**: 支持 Cron 表达式和简单间隔表达式
- 🎛️ **交互式管理**: 通过 InlineKeyboard 按钮管理群组
- ⚙️ **自动命令注册**: 启动时自动设置 BotFather 命令列表

## 安装

```bash
# 克隆项目
git clone <repo-url> TeleDigest
cd TeleDigest

# 安装依赖
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env 填写配置
```

## 配置

### 必需配置

```env
# 机器人 Token (从 @BotFather 获取)
TG_BOT_TOKEN=your_bot_token

# 机器人主人 User ID (从 @userinfobot 获取)
TG_BOT_OWNER_ID=123456789
```

### LLM 配置

```env
# LLM 提供商: openai / claude / gemini
LLM_PROVIDER=openai
LLM_API_KEY=your_api_key
LLM_MODEL=gpt-3.5-turbo
```

## 运行

### 方式一：直接运行

```bash
python -m TeleDigest
```

### 方式二：Docker 部署（推荐）

老王强烈推荐用 Docker 部署，省心省力，一键搞定！

#### 快速启动

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填写你的配置

# 2. 一键启动（自动构建镜像）
docker-compose up -d

# 3. 查看日志
docker-compose logs -f
```

#### 常用命令

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看运行状态
docker-compose ps

# 查看实时日志
docker-compose logs -f

# 重新构建镜像（代码更新后）
docker-compose up -d --build
```

#### 手动构建镜像

```bash
# 构建镜像
docker build -t teledigest-bot .

# 运行容器
docker run -d \
  --name teledigest-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  teledigest-bot
```

#### 数据持久化

- SQLite 数据库存储在 `./data/bot.db`
- 通过 Docker Volume 挂载，容器重建数据不丢失
- 建议定期备份 `data` 目录

### 方式三：Claw.cloud 云部署

适合没有服务器的用户，推送镜像到 Docker Hub 后在 Claw.cloud 一键部署。

#### 第一步：推送镜像到 Docker Hub

```bash
# 1. 登录 Docker Hub（没账号先去 https://hub.docker.com 注册）
docker login

# 2. 设置你的 Docker Hub 用户名
# Windows CMD:
set DOCKER_USERNAME=你的dockerhub用户名

# Windows PowerShell:
$env:DOCKER_USERNAME="你的dockerhub用户名"

# Linux/Mac:
export DOCKER_USERNAME=你的dockerhub用户名

# 3. 运行推送脚本
# Windows:
scripts\docker-push.bat

# Linux/Mac:
chmod +x scripts/docker-push.sh
./scripts/docker-push.sh
```

#### 第二步：在 Claw.cloud 部署

1. 访问 [Claw.cloud](https://claw.cloud) 并登录
2. 创建新应用，选择 **Container** 类型
3. 填写镜像地址：`你的用户名/teledigest-bot:latest`
4. 配置环境变量（重要！）：
   ```
   TG_BOT_TOKEN=你的机器人Token
   TG_BOT_OWNER_ID=你的TelegramUserID
   LLM_PROVIDER=openai
   LLM_API_KEY=你的LLM_API密钥
   LLM_MODEL=gpt-3.5-turbo
   TG_BOT_DB_PATH=/app/data/bot.db
   ```
5. 配置持久化存储（可选但推荐）：
   - 挂载路径：`/app/data`
   - 用于保存 SQLite 数据库
6. 点击部署，等待启动完成

#### 手动构建并推送（不用脚本）

```bash
# 1. 构建镜像
docker build -t 你的用户名/teledigest-bot:latest .

# 2. 推送到 Docker Hub
docker push 你的用户名/teledigest-bot:latest
```

### 方式四：GitHub Actions 自动构建（推荐懒人）

老王我给你整了一套 CI/CD 流水线，代码一推送就自动构建镜像发到 Docker Hub，省得你每次手动搞！

#### 配置步骤

1. **在 GitHub 仓库设置 Secrets**（重要！）

   进入仓库 → Settings → Secrets and variables → Actions → New repository secret

   | Secret 名称 | 值 |
   |-------------|-----|
   | `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名 |
   | `DOCKERHUB_TOKEN` | Docker Hub Access Token |

2. **获取 Docker Hub Access Token**

   - 登录 [Docker Hub](https://hub.docker.com)
   - 点击头像 → Account Settings → Security → New Access Token
   - 创建一个 Token，复制保存

3. **推送代码触发构建**

   ```bash
   git add .
   git commit -m "feat: 添加 CI/CD 自动构建"
   git push origin master
   ```

#### 触发条件

| 触发方式 | 说明 |
|----------|------|
| 推送到 `master`/`main` | 自动构建并打 `latest` 标签 |
| 创建版本标签 `v*.*.*` | 自动构建并打版本标签（如 `v1.0.0` → `1.0.0`） |
| 手动触发 | 在 Actions 页面点击 "Run workflow" |

#### 发布新版本

```bash
# 打标签发布新版本
git tag v1.0.0
git push origin v1.0.0

# 镜像会自动构建并推送：
# - 你的用户名/teledigest-bot:1.0.0
# - 你的用户名/teledigest-bot:1.0
# - 你的用户名/teledigest-bot:latest
```

#### 查看构建状态

在 GitHub 仓库页面点击 **Actions** 标签页，可以看到所有构建记录和日志。

## 使用流程

1. **配置环境变量**: 填写 `.env` 文件
2. **启动机器人**: 执行 `python -m TeleDigest`
3. **添加到群组**: 将机器人添加到需要总结的群组
4. **管理群组**: 私聊机器人发送 `/groups` 命令
5. **启用总结**: 点击群组按钮，选择「启用总结」
6. **设置定时**: 按提示设置定时任务表达式

## 命令列表

| 命令 | 说明 |
|------|------|
| `/start` | 启动机器人 |
| `/help` | 显示帮助信息 |
| `/groups` | 查看群组列表（交互式管理） |
| `/enable <群组ID>` | 启用群组总结 |
| `/disable <群组ID>` | 禁用群组总结 |
| `/setschedule <群组ID> <表达式>` | 设置定时任务 |
| `/status` | 查看所有群组状态 |
| `/summary <群组ID>` | 手动触发总结 |

## 定时表达式

支持两种格式：

### Cron 表达式（5 段）
```
分 时 日 月 周
0 9 * * *      # 每天 9:00
0 */2 * * *    # 每 2 小时
30 8 * * 1-5   # 工作日 8:30
```

### 简单间隔
```
1h    # 每小时
30m   # 每 30 分钟
2h    # 每 2 小时
```

## 项目结构

```
TeleDigest/
├── __init__.py          # 模块入口
├── __main__.py          # 启动入口
├── config.py            # 配置管理
├── bot.py               # 机器人主类
├── handlers/            # 命令处理器
│   ├── __init__.py
│   └── admin.py         # 管理员命令
├── scheduler/           # 定时任务
│   ├── __init__.py
│   └── task_manager.py  # 任务管理器
├── summarizer/          # 总结功能
│   ├── __init__.py
│   └── api_client.py    # LLM API 客户端
└── storage/             # 数据存储
    ├── __init__.py
    └── bot_db.py        # SQLite 数据库
```

## 许可证

MIT License
