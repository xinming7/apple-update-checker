# Apple Update Checker

通过 GitHub Actions 定时检查苹果系统更新（iOS、macOS、watchOS、tvOS、visionOS），结果自动保存到仓库，有新版本时自动创建 Issue 通知。

## 功能特性

- 每天北京时间 10:00 自动检查更新
- 支持 iOS、macOS、watchOS、tvOS、visionOS 五大平台
- 网络失败自动重试（3次）
- 检测到新版本自动创建 GitHub Issue 通知
- 保留历史版本记录

## 更新状态

查看 [UPDATE_STATUS.md](./UPDATE_STATUS.md) 获取最新检查结果。

## Issue 通知

检测到新版本时会自动创建带有 `apple-update` 标签的 Issue。在仓库 → Issues → Labels → `apple-update` 可查看所有更新通知。

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

## 本地运行

```bash
node scripts/check-updates.js
```

## 项目结构

```
apple-update-checker/
├── scripts/
│   └── check-updates.js      # 检查脚本（含重试、变更检测）
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
