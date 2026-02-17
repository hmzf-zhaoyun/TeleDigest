# TeleDigest - Telegram 群组消息总结机器人

基于 Cloudflare Workers 的 Telegram 机器人，提供群组消息定时 AI 总结、发言排行榜、剧透模式、Linux.do 帖子预览等功能。

## 功能特性

- 📝 **AI 消息总结**：定时收集群组消息，调用 LLM 生成摘要
- 🏆 **发言排行榜**：可配置的统计窗口，定时发布群组活跃排行
- 🔐 **剧透模式**：转发或 #nsfw 标签触发，支持自动删除原消息
- 📸 **Linux.do 预览**：自动识别 Linux.do 链接，提取帖子内容并以相册形式发送
- 🎛️ **交互式管理面板**：私聊机器人通过按钮管理所有群组，无需记命令
- ⏰ **灵活调度**：支持简单间隔（`30m`/`2h`/`1d`）和 5 段 Cron 表达式
- 🤖 **多 LLM 支持**：OpenAI / OpenAI Responses / Claude / Gemini / 自定义兼容接口

## 技术栈

- **运行时**：Cloudflare Workers
- **语言**：TypeScript
- **数据库**：Cloudflare D1 (SQLite)
- **KV 存储**：Cloudflare KV（群组注册表备份）
- **消息接收**：Telegram Webhook
- **定时触发**：Cron Triggers（每分钟检查）

## 部署

### 前置条件

- Node.js 环境
- Cloudflare 账号，已完成 `npx wrangler login`

### 一键部署（推荐）

1. 安装依赖
   ```bash
   npm install
   ```

2. 创建 `.env.worker`（不会提交到仓库）
   ```env
   TG_BOT_TOKEN=your_bot_token_here
   TG_BOT_OWNER_ID=123456789
   LLM_API_KEY=your_llm_api_key
   # 可选
   LLM_PROVIDER=openai-responses
   LLM_MODEL=gpt-4o-mini
   LLM_API_BASE=
   LLM_MAX_TOKENS=1000
   LLM_TEMPERATURE=0.7
   TG_WEBHOOK_SECRET=
   SCHEDULE_TZ_OFFSET_MINUTES=480
   # 选填：自动拼接 Webhook URL
   WORKERS_DEV_SUBDOMAIN=your-subdomain
   # 或直接指定完整地址
   # WEBHOOK_URL=https://<name>.<subdomain>.workers.dev/telegram
   ```

3. 运行一键部署脚本
   ```bash
   npm run deploy:oneclick
   ```

脚本会自动创建/绑定 D1 与 GROUPS_KV、初始化 schema、写入 secrets、部署并设置 Webhook。

额外参数：
```bash
npm run deploy:oneclick -- --skip-webhook
npm run deploy:oneclick -- --webhook-url https://xxx.workers.dev/telegram
npm run deploy:oneclick -- --workers-subdomain your-subdomain
npm run deploy:oneclick -- --env-file .env.worker
```

### 手动部署

1. 安装依赖
   ```bash
   npm install
   ```
2. 登录 Cloudflare
   ```bash
   npx wrangler login
   ```
3. 创建 D1 数据库
   ```bash
   npx wrangler d1 create teledigest-db
   ```
   将输出的 `database_id` 写入 `wrangler.toml`
4. 初始化数据库
   ```bash
   npm run db:init
   ```
5. 配置 Secrets
   ```bash
   npx wrangler secret put TG_BOT_TOKEN
   npx wrangler secret put TG_BOT_OWNER_ID
   npx wrangler secret put LLM_API_KEY
   # 以及其他可选变量...
   ```
6. 部署
   ```bash
   npm run deploy
   ```
7. 设置 Telegram Webhook
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<worker>.<subdomain>.workers.dev/telegram" \
     -d "secret_token=<TG_WEBHOOK_SECRET>"
   ```

### 切换 Bot Token

只替换 Token 不重新部署代码：

```bash
npm run bot:switch
```

可选参数：
```bash
npm run bot:switch -- --token <TOKEN>
npm run bot:switch -- --webhook-url <URL>
npm run bot:switch -- --skip-webhook
npm run bot:switch -- --owner-id <ID>
```

## 使用方式

1. 将机器人添加到群组
2. 私聊机器人，点击「管理面板」按钮
3. 选择群组 → 启用总结 → 设置定时
4. 剧透模式、排行榜、Linux.do 预览等均可在面板中配置

## 配置说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `TG_BOT_TOKEN` | ✅ | Telegram Bot Token |
| `TG_BOT_OWNER_ID` | ✅ | 机器人主人的 User ID |
| `LLM_API_KEY` | ✅ | LLM API 密钥 |
| `LLM_PROVIDER` | | `openai-responses` / `openai` / `claude` / `gemini` / `custom` |
| `LLM_MODEL` | | 模型名称，默认 `gpt-4o-mini` |
| `LLM_API_BASE` | | 自定义 API 地址 |
| `LLM_MAX_TOKENS` | | 最大输出 token，默认 `1000` |
| `LLM_TEMPERATURE` | | 温度参数，默认 `0.7` |
| `TG_WEBHOOK_SECRET` | | Webhook 校验密钥 |
| `SCHEDULE_TZ_OFFSET_MINUTES` | | 时区偏移（分钟），北京时间填 `480` |
| `SCRAPE_DO_TOKEN` | | Scrape.do Token（Linux.do 预览用） |

## 定时表达式

支持两种格式：

**简单间隔**：`30m` / `1h` / `2h` / `1d`

**Cron 表达式（5 段）**：
```
分 时 日 月 周
0 9 * * *      # 每天 9:00
0 */2 * * *    # 每 2 小时
30 8 * * 1-5   # 工作日 8:30
```

Cron 使用 UTC 时间，设置 `SCHEDULE_TZ_OFFSET_MINUTES=480` 可转换为北京时间。

## 项目结构

```
TeleDigest/
├── src/
│   ├── index.ts              # Worker 入口（fetch + scheduled）
│   ├── types.ts              # 类型定义
│   ├── constants.ts          # 常量与预设选项
│   ├── db.ts                 # D1 数据库操作
│   ├── schedule.ts           # 定时总结调度
│   ├── leaderboard.ts        # 发言排行榜
│   ├── summary.ts            # LLM 总结逻辑
│   ├── registry.ts           # 群组 KV 注册表
│   ├── utils.ts              # 工具函数
│   └── telegram/
│       ├── api.ts            # Telegram Bot API 封装
│       ├── handlers.ts       # Webhook 消息处理
│       ├── linuxdo.ts        # Linux.do 帖子预览
│       ├── quote.ts          # 消息引用处理
│       └── spoiler.ts        # 剧透模式处理
├── schema.sql                # D1 数据库 schema
├── wrangler.toml             # Workers 配置
├── package.json              # 依赖管理
├── tsconfig.json             # TypeScript 配置
└── .env.worker.example       # 环境变量模板
```

## 许可证

MIT License
