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

```bash
python -m TeleDigest
```

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
