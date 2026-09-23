# Apple Update Checker

基于 Cloudflare Workers 的 Apple 系统更新检查服务。

## 功能特性

- 检查 iOS、macOS、watchOS、tvOS 的最新更新
- 提供 RESTful API 接口
- 支持 CORS 跨域请求
- 全球边缘节点部署，低延迟响应

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api` | API 信息 |
| `GET /api/updates/ios` | 获取 iOS 更新 |
| `GET /api/updates/macos` | 获取 macOS 更新 |
| `GET /api/updates/watchos` | 获取 watchOS 更新 |
| `GET /api/updates/tvos` | 获取 tvOS 更新 |
| `GET /api/updates/all` | 获取所有平台更新 |

## 响应示例

```json
{
  "success": true,
  "timestamp": "2026-09-23T09:48:27.000Z",
  "count": 3,
  "updates": [
    {
      "platform": "iOS",
      "version": "19.0.1",
      "build": "23A355",
      "releaseType": "Release",
      "postingDate": "2026-09-22T07:00:00Z",
      "supportedDevices": ["iPhone16,1", "iPhone15,2"]
    }
  ]
}
```

## 部署

### 前置要求

1. Cloudflare 账号
2. Node.js 18+
3. Wrangler CLI

### 本地开发

```bash
npm install
npm run dev
```

### 部署到 Cloudflare

```bash
npm run deploy
```

### GitHub Actions 自动部署

1. 在 Cloudflare 获取 API Token 和 Account ID
2. 在 GitHub 仓库设置中添加 Secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. 推送到 `main` 分支即可自动部署

## 项目结构

```
apple-update-checker/
├── src/
│   └── index.js          # Worker 主文件
├── wrangler.toml         # Cloudflare Workers 配置
├── package.json
├── .github/
│   └── workflows/
│       └── deploy.yml    # GitHub Actions 配置
└── README.md
```

## License

MIT
