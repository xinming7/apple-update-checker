# Apple Update Checker

通过 GitHub Actions 定时检查苹果系统更新（iOS、macOS、watchOS、tvOS、visionOS），结果自动保存到仓库，有新版本时自动创建 Issue 和 Telegram 通知。

## 功能特性

### 🔔 通知与订阅
- 每天北京时间 10:00 自动检查更新
- 检测到新版本自动创建 GitHub Issue 通知
- 支持 Telegram Bot 推送通知
- **RSS Feed** 输出，可用任意 RSS 阅读器订阅

### 📱 平台支持
- iOS、macOS、watchOS、tvOS、visionOS 五大平台
- **XProtect 更新监控**（macOS 安全签名）
- 支持平台过滤，只关注你关心的平台

### 🔒 安全特性
- **CVE 安全漏洞追踪**，自动抓取 Apple Security Updates 页面
- **release notes 摘要**，显示每次更新修复的安全问题
- **安全更新 vs 功能更新分类**（大版本/小版本/安全响应 RSR）

### 📊 分析功能
- **更新间隔统计**，显示各平台平均更新频率
- **固件下载链接**，Apple 官方 OTA 和 IPSW.me 链接
- 网络失败自动重试（3次）

## 更新状态

- [UPDATE_STATUS.md](./UPDATE_STATUS.md) — 系统更新状态
- [SECURITY_STATUS.md](./SECURITY_STATUS.md) — 安全公告追踪
- [feed.xml](./feed.xml) — RSS Feed

## 通知方式

### GitHub Issue

检测到新版本时自动创建带 `apple-update` 标签的 Issue。

### Telegram Bot

**配置步骤：**

1. 与 [@BotFather](https://t.me/BotFather) 创建一个 Bot，获取 Token
2. 获取你的 Chat ID（发消息给 [@userinfobot](https://t.me/userinfobot)）
3. 在 GitHub 仓库 → Settings → Secrets and variables → Actions，添加：
   - `TELEGRAM_BOT_TOKEN` — Bot 的 Token
   - `TELEGRAM_CHAT_ID` — 你的 Chat ID

### RSS Feed

订阅 `feed.xml`（如 `https://<username>.github.io/apple-update-checker/feed.xml`），或通过 GitHub Raw 链接访问。

### Update Hub

如需接入 Update Hub，添加以下 Secrets：
- `UPDATE_HUB_URL` — Update Hub 地址
- `UPDATE_HUB_TOKEN` — 访问 Token

## 平台过滤

在 GitHub 仓库 → Settings → Secrets and variables → Variables 中添加：
- `PLATFORMS` — 逗号分隔的平台列表，如 `ios,macos`（留空则检查全部）

本地测试：

```bash
# 检查所有平台
node scripts/check-updates.js

# 只检查 iOS 和 macOS
PLATFORMS="ios,macos" node scripts/check-updates.js

# 带 Telegram 通知
TELEGRAM_BOT_TOKEN="token" TELEGRAM_CHAT_ID="chat_id" node scripts/check-updates.js
```

## 更新类型分类

| 标记 | 类型 | 说明 |
|------|------|------|
| 🟢 | 大版本更新 | iOS 19 → iOS 20 |
| 🔵 | 小版本更新 | iOS 19.0 → iOS 19.1 |
| 🔴 | 安全响应 (RSR) | Rapid Security Response |
| 🛡️ | XProtect 更新 | macOS 安全签名更新 |

## 数据文件

`data/` 目录包含结构化数据：

| 文件 | 说明 |
|------|------|
| `updates.json` | 系统更新数据（含更新类型、固件链接、间隔统计） |
| `security.json` | 安全公告数据（CVE 列表、release notes 摘要） |
| `xprotect.json` | XProtect 版本记录 |

## 手动触发

在 GitHub 仓库 → Actions → "Check Apple Updates" → "Run workflow"

## 项目结构

```
apple-update-checker/
├── scripts/
│   ├── check-updates.js      # 系统更新检查（含 XProtect、平台过滤、更新分类）
│   ├── security-scanner.js   # 安全公告扫描（CVE 追踪、release notes）
│   ├── generate-rss.js       # RSS Feed 生成器
│   └── daily-digest.js       # Update Hub 每日汇总
├── .github/
│   └── workflows/
│       ├── check-update.yml  # 主定时任务（更新检查 + 安全扫描 + RSS）
│       └── daily-digest.yml  # 每日汇总 Telegram 推送
├── data/
│   ├── updates.json          # 更新数据（自动生成）
│   ├── security.json         # 安全数据（自动生成）
│   └── xprotect.json         # XProtect 记录（自动生成）
├── UPDATE_STATUS.md          # 更新状态（自动生成）
├── SECURITY_STATUS.md        # 安全追踪（自动生成）
├── feed.xml                  # RSS Feed（自动生成）
└── README.md
```

## License

MIT
