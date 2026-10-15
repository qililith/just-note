# 只是便签 / Just Note

个人便签。打开后直接读这台设备上的数据，编辑先落本地，再同步到云端。

当前这一步只完成了本地编辑。云端同步、冲突的跨设备处理、安卓安装包还没接上。

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

## 检查

```powershell
pnpm test
pnpm typecheck
pnpm build
```
