# 只是便签 / Just Note

个人便签。打开后直接读这台设备上的数据，编辑先落本地，再同步到云端。

当前这一步：本地编辑与云端同步引擎已接上；站点 [just-note.pages.dev](https://just-note.pages.dev) 已发布。若 Cloudflare 尚未连上 GitHub，推送 `master` 不会自动发版，需按下方清单接好。

## 本地运行

```powershell
pnpm install
pnpm dev
```

复制 `.env.example` 为 `.env.local` 后填写 Supabase 地址和 publishable key。开发时把 `VITE_DEMO_MODE=true` 可以不登录，数据存在本机的 `local-demo` 库里。

## 已定的名字

- 界面中文名：只是便签
- 英文名：Just Note
- 包名：`just-note`
- 安卓应用 ID：`com.justnote`（第一次装到手机后不能改）

## Cloudflare Pages 自动部署

仓库：[qililith/just-note](https://github.com/qililith/just-note)。生产域名：`https://just-note.pages.dev`。

构建配置（连上 Git 后填一次即可）：

| 项 | 值 |
|----|----|
| Production branch | `master` |
| Build command | `pnpm install && pnpm build` |
| Build output directory | `dist` |
| Root directory | `/`（仓库根） |

Production 环境变量（**不要**填 service_role）：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

与本地 `.env.local` 同源。改完环境变量后点 Retry deployment，或再推一次 `master`。

### 第一次把项目连到 GitHub（需浏览器登录 Cloudflare）

1. 打开 [Cloudflare Dashboard → Workers & Pages](https://dash.cloudflare.com/) → 项目 `just-note`。
2. **Settings → Builds & deployments → Connect to Git**（或 Create deployment → Connect to Git），选 GitHub 仓库 `qililith/just-note`。
3. 授权 Cloudflare 访问该仓库（若账号里还没有 GitHub 连接，先完成 OAuth）。
4. 填上表的分支、构建命令、`dist`。
5. **Settings → Environment variables → Production**：添加上面两个 `VITE_*` 变量。
6. 保存后触发一次 Production 部署；打开 `https://just-note.pages.dev`，确认登录页能连云端（不要出现「尚未配置云端服务」）。

未连 Git 时仍可用手动发版：`pnpm build` 后 `npx wrangler pages deploy dist --project-name just-note --branch master`。

旧站 `sticky-notes-local-first.pages.dev` 在迁移验证通过前先保留。

## 检查

```powershell
pnpm test
pnpm typecheck
pnpm build
```
