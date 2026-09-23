# Apple Update Checker

通过 GitHub Actions 定时检查苹果系统更新（iOS、macOS、watchOS、tvOS），结果自动保存到仓库。

## 工作原理

- GitHub Actions 每天北京时间 10:00 自动运行
- 从 Apple OTA Feed 获取最新版本信息
- 更新 `UPDATE_STATUS.md` 和 `data/updates.json`
- 纯 GitHub 方案，无需额外服务

## 更新状态

查看 [UPDATE_STATUS.md](./UPDATE_STATUS.md) 获取最新检查结果。

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
│   └── check-updates.js   # 检查脚本
├── .github/
│   └── workflows/
│       └── check-update.yml  # 定时任务
├── data/
│   └── updates.json       # 更新数据（自动生成）
├── UPDATE_STATUS.md       # 更新状态（自动生成）
└── README.md
```

## License

MIT
