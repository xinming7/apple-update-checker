# Apple Update Checker

通过 GitHub Actions 定时检查苹果系统更新（iOS、macOS、watchOS、tvOS、visionOS），结果自动保存到仓库，有新版本时自动创建 Issue 和 Telegram 通知。

## 功能特性

### 🔔 通知与订阅
- 每天北京时间 10:00 自动检查更新
- 检测到新版本自动创建 GitHub Issue 通知
- 支持 Telegram Bot 推送通知（HTML 安全截断，不会破坏标签）
- **RSS Feed** 输出（Atom 格式），可用任意 RSS 阅读器订阅
- 每日北京时间 20:00 汇总推送（需接入 Update Hub）

### 📱 平台支持
- iOS、macOS、watchOS、tvOS、visionOS 五大平台
- 支持平台过滤，只关注你关心的平台（`PLATFORMS` 环境变量）
- 过滤时自动保留其余平台历史数据，避免误报

### 🔒 安全特性
- **CVE 安全漏洞追踪**，自动抓取 Apple Security Updates 页面
- **release notes 摘要**，显示每次更新修复的安全问题
- **安全更新 vs 功能更新分类**（大版本/小版本/安全响应 RSR）

### 📊 分析功能
- **更新间隔统计**，显示各平台平均更新频率
- **固件下载链接**（Apple 官方 OTA，仅 iOS/watchOS/tvOS 有）
- 请求超时 30s + 失败自动重试（3 次）

## 数据源架构

| 数据源 | 类型 | 用途 | 覆盖平台 |
|--------|------|------|----------|
| `gdmf.apple.com/v2/pmv` | JSON（主源） | 版本 / Build / PostingDate / RSR 标记 | 全 5 平台 |
| `mesu.apple.com` OTA feed | XML plist（辅助） | 补充固件下载链接与大小 | iOS / watchOS / tvOS |
| Apple Developer Docs | JSON（Beta） | Beta 版本检测 | 全 5 平台 |

- gdmf/pmv 通过 `PublicAssetSets` 和 `PublicBackgroundSecurityImprovements` 分别提供正式版本和 RSR
- mesu feed 的 `OSVersion` 带 `9.9.` 打码前缀（如 `9.9.27.0` 实为 `27.0`），脚本自动归一化
- macOS / visionOS 无公开 mesu XML feed，固件链接正确留空

### 更新类型分类

| 标记 | 类型 | 判断规则 |
|------|------|----------|
| 🔴 | 安全响应 (RSR) | 标题含 `Rapid Security Response`、`ProductVersionExtra` 或版本形如 `(a)` |
| 🟢 | 大版本更新 | 纯主版本 `x` 或 `x.0` |
| 🔵 | 小版本更新 | `x.y` / `x.y.z` |
| 🛡️ | XProtect 更新 | macOS 安全签名（当前暂不可用，见下方说明） |
| 🧪 | Beta 版本 | 从 Apple Developer Docs 提取（见下方说明） |

### Beta 版本检测

通过 Apple Developer Docs 的 release-notes JSON 端点检测各平台最新 Beta 版本。每个平台的页面标题包含版本信息（如 `iOS & iPadOS 27.2 Beta 2 Release Notes`），脚本自动提取并展示在 Telegram 通知的对应平台 Tag 下。

覆盖平台：iOS、macOS、watchOS、tvOS、visionOS。

### XProtect 说明

gdmf/pmv 不含 XProtect 数据，需接入 Pallas（`gdmf/v2/assets` + `XProtectPlistConfigData` 的 AssetAudience）。当前检测会自动跳过并保留旧记录。

## 更新状态

- [UPDATE_STATUS.md](./UPDATE_STATUS.md) — 系统更新状态
- [SECURITY_STATUS.md](./SECURITY_STATUS.md) — 安全公告追踪
- [feed.xml](./feed.xml) — RSS Feed

## 配置

### 必需 Secrets

在 GitHub 仓库 → Settings → Secrets and variables → Actions 中添加：

| Secret | 用途 |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取） |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID（从 [@userinfobot](https://t.me/userinfobot) 获取） |

### 可选 Secrets

| Secret | 用途 |
|--------|------|
| `UPDATE_HUB_URL` | Update Hub 仪表盘地址 |
| `UPDATE_HUB_TOKEN` | Update Hub 访问 Token |

### 可选 Variables

| Variable | 用途 | 示例 |
|----------|------|------|
| `PLATFORMS` | 只检查指定平台（逗号分隔） | `ios,macos` |

## 本地测试

```bash
# 检查所有平台
node scripts/check-updates.js

# 只检查 iOS 和 macOS
PLATFORMS="ios,macos" node scripts/check-updates.js

# 指定仓库地址（用于生成链接）
REPO_URL="https://github.com/你的用户名/apple-update-checker" node scripts/check-updates.js

# 带 Telegram 通知
TELEGRAM_BOT_TOKEN="token" TELEGRAM_CHAT_ID="chat_id" node scripts/check-updates.js

# 扫描安全公告
node scripts/security-scanner.js

# 生成 RSS Feed
node scripts/generate-rss.js
```

> GitHub Actions 环境中 `REPO_URL` 自动从 `github.repository` 注入，本地运行需手动设置。

## 手动触发

在 GitHub 仓库 → Actions → "Check Apple Updates" → "Run workflow"

## 项目结构

```
apple-update-checker/
├── scripts/
│   ├── check-updates.js      # 系统更新检查（主源 gdmf/pmv + 辅助 mesu）
│   ├── security-scanner.js   # 安全公告扫描（CVE 追踪、release notes）
│   ├── generate-rss.js       # RSS Feed 生成器（Atom 格式）
│   └── daily-digest.js       # Update Hub 每日汇总（Telegram 推送）
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

### 数据文件说明

| 文件 | 说明 |
|------|------|
| `data/updates.json` | 系统更新数据（含更新类型、固件链接、间隔统计、firstSeen） |
| `data/security.json` | 安全公告数据（CVE 列表、release notes 摘要） |
| `data/xprotect.json` | XProtect 版本记录（当前不可用时保留旧记录） |

## 已知限制

1. **XProtect 检测暂不可用** — gdmf/pmv 不含 XProtect 数据，需接入 Pallas AssetAudience
2. **固件链接覆盖不全** — macOS / visionOS 无公开 mesu feed，Apple TV 4K（型号 A1842 等）不在 mesu feed 中
3. **security-scanner 依赖 HTML 正则** — Apple 改版会失效，建议后续换官方结构化数据

## License

MIT
