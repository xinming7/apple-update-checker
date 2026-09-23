# Apple Update Checker

通过 GitHub Actions 定时检查苹果系统更新（iOS、macOS、watchOS、tvOS、visionOS），结果自动保存到仓库，有新版本时自动创建 Issue 通知。

## 功能特性

- 每天北京时间 10:00 自动检查更新
- 支持 iOS、macOS、watchOS、tvOS、visionOS 五大平台
- 网络失败自动重试（3次）
- 检测到新版本自动创建 GitHub Issue 通知
- 支持 Telegram Bot 推送通知
- 保留历史版本记录

## 更新状态

查看 [UPDATE_STATUS.md](./UPDATE_STATUS.md) 获取最新检查结果。

## 通知方式

### GitHub Issue

检测到新版本时会自动创建带有 `apple-update` 标签的 Issue。在仓库 → Issues → Labels → `apple-update` 可查看所有更新通知。

### Telegram Bot

检测到新版本时会同时通过 Telegram Bot 推送通知。

**配置步骤：**

1. 与 [@BotFather](https://t.me/BotFather) 创建一个 Bot，获取 Token
2. 获取你的 Chat ID（可以发消息给 [@userinfobot](https://t.me/userinfobot)）
3. 在 GitHub 仓库 → Settings → Secrets and variables → Actions，添加：
   - `TELEGRAM_BOT_TOKEN` — Bot 的 Token
   - `TELEGRAM_CHAT_ID` — 你的 Chat ID

本地测试：

```bash
TELEGRAM_BOT_TOKEN="your_token" TELEGRAM_CHAT_ID="your_chat_id" node scripts/check-updates.js
```

## 数据文件

`data/updates.json` 包含结构化数据，可用于其他项目：

```json
{
  "lastChecked": "2026-09-23T02:00:00.000Z",
  "platforms": {
    "ios": {
      "name": "iOS",
      "updates": [
        { "platform": "iOS", "version": "19.0.1", "build": "23A355", "postingDate": "2026-09-22T07:00:00Z" }
      ]
    }
  }
}
```

## 手动触发

在 GitHub 仓库 → Actions → "Check Apple Updates" → "Run workflow"

## 项目结构

```
apple-update-checker/
├── scripts/
│   └── check-updates.js      # 检查脚本（含重试、变更检测、Telegram 通知）
├── .github/
│   └── workflows/
│       └── check-update.yml  # 定时任务 + Issue 通知
├── data/
│   └── updates.json          # 更新数据（自动生成）
├── UPDATE_STATUS.md          # 更新状态（自动生成）
└── README.md
```

## License

MIT
