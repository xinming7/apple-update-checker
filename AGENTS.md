# apple-update-checker

## 这是什么
每天抓 Apple 各平台（iOS / macOS / watchOS / tvOS / visionOS）的系统更新与安全公告，把增量变成可订阅的产物：
GitHub Issue + Telegram 推送、`UPDATE_STATUS.md`、`SECURITY_STATUS.md`、Atom `feed.xml`，同时把新版本上报给
update-hub，让所有订阅源汇到一个仪表盘。自用项目，当前在线上运行（GitHub Actions 每日自动执行并回写仓库）。
入口文件：`scripts/check-updates.js`。

## 技术栈
Node.js 22 + 纯 JavaScript（CommonJS），零运行时依赖（`package.json` 无 `dependencies` / `devDependencies`），
只用 Node 内置模块加 `fetch` / `curl` fallback。**不是 Cloudflare Worker**：没有 `wrangler.toml`，
没有任何 CF 绑定，全部逻辑跑在 GitHub Actions 上。辅助入口：`scripts/security-scanner.js`、
`scripts/generate-rss.js`、`scripts/daily-digest.js`、`scripts/utils.js`。

## 常用命令
- 安装依赖：零依赖，无需安装
- 本地开发：`npm run check`（= `node scripts/check-updates.js`；需 `PLATFORMS`、`TELEGRAM_BOT_TOKEN`、
  `TELEGRAM_CHAT_ID`、`UPDATE_HUB_URL`、`UPDATE_HUB_TOKEN`、`REPO_URL` 环境变量）
- 测试：`npm test`（= `node --test test/logic.test.js`，27 个用例，用 Node 内置 test runner，零依赖）
- 部署：（无）——本项目没有部署动作，见下
- 其它真实脚本：`npm run security`、`npm run rss`、`npm run digest`

## 改动流程（用户明确要求）
**每次改完代码，在 commit / push 之前先告诉用户 `README.md` 要不要更新、具体改哪几行、改成什么，
等用户确认后再提交。** README 里的部署方式、配置项、API 端点、可靠性行为都可能随改动过期。

同理，`AGENTS.md` 本身记录的环境事实（部署方式、凭据状态、已知坑）如果被改动影响，也要一并更新。

## 部署与 CI
没有部署环节，CI 就是运行本体，两个工作流：

**关于 cron 时间：别信名义值。** GitHub Actions 的 `schedule` 会延迟，官方文档说高负载时
「delayed or dropped entirely」。实测本仓库 2026-10-01 ~ 10-14 的 12 次调度运行，名义 UTC 02:00
的 cron 实际都落在 UTC 07:15~09:05，稳定偏晚 5~7 小时。所以判断"跑没跑"要看
`gh run list`，不要按 cron 名义时间推断；也别按"每天固定某点"去设计依赖。

- `.github/workflows/check-update.yml`（active）：`schedule: cron '0 18,0,6,12 * * *'`
  （名义每 6 小时）+ `workflow_dispatch`；
  `concurrency: check-apple-updates`；权限 `contents: write, issues: write`。依次跑 check → security → rss，
  检测到新版本（输出含 `NEW UPDATES DETECTED`）时用 `actions/github-script` 建 Issue（同名去重），
  最后把 `data/`、`UPDATE_STATUS.md`、`SECURITY_STATUS.md`、`feed.xml` 以
  `chore: update Apple system info [date]` 提交回 `main`。
- `.github/workflows/daily-digest.yml`（**已手动禁用 `disabled_manually`**，2026-09-25 后无运行）：
  `cron '0 12 * * *'` + `workflow_dispatch`，跑 `scripts/daily-digest.js` 拉 update-hub 的
  `/api/daily-digest` 再推 Telegram。禁用原因是与 update-hub 自己的 digest 重复推送
  （见下方坑列表那条「两条链路」）。要改回这里推，先在 GitHub 上重新启用。
仓库 Secret：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`，可选 `UPDATE_HUB_URL`、`UPDATE_HUB_TOKEN`；
仓库 Variable：`PLATFORMS`。无 Cloudflare 凭据，无 `wrangler deploy`。

## 改这个项目时的坑
- **别当 Worker 改**：不存在 `wrangler.toml`、KV/D1 绑定或 `wrangler deploy` 这条路径。
- 主数据源 `https://gdmf.apple.com/v2/pmv` 必须保留 `curlFallback: true`——Node fetch 不信任 Apple CDN
  证书链，去掉 fallback 会直接抓不到数据。XProtect 检查**永远不可用**（需要 Apple Pallas 的
  `AssetAudience`），代码只记日志跳过，不是待修 bug。
- `security-scanner.js` 靠正则解析 `https://support.apple.com/en-us/100100` 的 HTML 并逐个跟进公告页，
  Apple 一改版它会解析不出条目。已加护栏：零条目时**保留上一份公告文件**并打印
  `=== SECURITY SCAN DEGRADED ===`，`check-update.yml` 检测到该字样会写进 Step Summary 告警
  （故意不 exit 非零，避免整条工作流失败）。mesu plist 抓取在部分环境会撞 `ENOBUFS` 类缓冲溢出
  （设计上非致命，返回 `null`），而且只有 iOS/watchOS/tvOS 有 mesu 源，macOS 与 visionOS 没有。
- 工作流结尾会 `git push` 回 `main`，分支保护开启会让这一步失败；本地跑 `npm run check` 同样会改写
  `data/` 与状态文件。
- Telegram 推送有两条链路：这里的 `daily-digest.yml` 与 update-hub 自己的 cron digest。update-hub 的
  `wrangler.toml` 注释写明二选一，改动前先确认哪条在生效。
- 上游依赖 update-hub 的 `POST /api/projects/ios-update-check/updates`（项目名 `ios-update-check`）与
  `GET /api/daily-digest`；改 update-hub 的接口契约会打断这里（404 时自动注册项目再重试一次，
  这个语义别乱改）。
