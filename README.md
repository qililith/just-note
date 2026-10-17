# 只是便签 / Just Note

个人便签。打开先读本机；编辑无条件写入本地；有网时自动同步云端，并提供手动同步。

| | |
|--|--|
| 仓库 | [qililith/just-note](https://github.com/qililith/just-note) |
| Web | [just-note.pages.dev](https://just-note.pages.dev) |
| 安卓 ID | `com.justnote`（装机后不可改） |
| 进度 | [docs/进度.md](docs/进度.md) |

本仓库基础文档只有两份：**本 README（需求 + 固定技术路径 + 文档纪律）**，以及 **[docs/进度.md](docs/进度.md)（做到哪）**。

---

## 文档纪律（每次对话 / 任务）

**先读 README**，当任务涉及：本地保存、同步、冲突、登录与冷启动、云端表/RPC、安卓数据与生命周期、产品范围（导出/导入/历史）。

**先读 [docs/进度.md](docs/进度.md)**，当任务是推进功能、验收、发版或排优先级。

**必须改 README（并同步改进度里对应勾选）**，当发生任一情况：

- 同步触发时机、冲突规则、本地表字段含义、云端 RPC 约定有变
- 产品 Must 行为有变（不丢字、自动同步、手动同步反馈、冲突三选）
- 品牌名、应用 ID、仓库/站点地址有变

**只改进度、不动 README**，当只是完成度变化（某项做完、验收通过、APK 打出、CF 已连接等）。

改代码前先对照 README 里的固定路径；若要实现路径与 README 不一致，**先改文档并得到确认，再改代码**。

---

## 产品 Must（与规格书一致）

1. **不丢字：** 编辑器输入以最直接路径写入本机库。网络断开、同步进行中、云端版本不一致，都不能拒绝或打断本地保存。
2. **自动同步：** 页面唤醒、切回前台、网络恢复、编辑停顿后自动同步；常规约 30 秒内完成（最高容忍约 1 分钟）。自动同步失败只更新状态图标，不弹窗、不 Toast。
3. **手动同步：** 常驻可靠入口。成功提示「同步成功（HH:mm）」；失败提示「同步失败」。
4. **冲突：** 两端都改过同一条便签时，禁止静默覆盖；弹窗三选：保留本地版本、保留云端版本、两者皆保留（本地另存副本）。
5. **冷启动：** 用上次账号直接打开本地库并显示列表；登录校验在后台进行，首屏不堵在网络上。
6. **编辑中：** 正在输入时，拉取到的云端更新不覆盖当前正文、不打断光标与输入法；非编辑态可直接刷新为最新。

已确认选项：正文为 TipTap JSON + 纯文本；文件夹冲突以云端为准；便签含置顶/文件夹在内的版本冲突一律弹窗；首版做导出；安卓 `com.justnote`。

---

## 固定技术路径（怎么做）

### 本地（Dexie）

- 每账号一库：`just-note-<userId>`。退出登录不删库；「清除本机数据」删库。
- 表：
  - `notes`：列表字段、摘要、`dirty`、`serverVersion`、`editSeq`、`hasConflict`
  - `bodies`：正文 JSON + 纯文本（与列表分离）
  - `conflicts`：冲突时保留的另一版
  - `folders`
  - `meta`：同步游标、mutation 幂等 id、上次同步时间等
- 保存：停顿约 **300ms** 写入；连续输入最长约 **1s** 必写一次。`visibilitychange`（hidden）、`pagehide`、编辑器失焦、切便签/返回前立刻 flush。写入只置 `dirty`，不读云端版本决定是否允许保存。若写入时 `editSeq` 已变，先把库中旧正文放入 `conflicts`，再写入当前内容。
- 回收站：软删除，本机约 30 天清理；彻底删除需联网（若产品已接）。

### 同步

- 云端：Supabase；RPC **`pull_changes`**（按游标分页拉变更）、**`apply_mutation`**（带 `mutation_id` 幂等写入）。客户端在 `meta` 中为每条脏实体保留稳定 mutation id，成功后清除。
- 一轮同步顺序：`pull` → 推送所有 `dirty` 的 folders 再 notes → 再 `pull`。
- 拉到文件夹：以云端为准，写本地并清 dirty。
- 拉到便签：无本地或本地不脏 → 套用云端；本地脏或正在编辑且与云端**正文/夹/置顶/删除**实质不同 → 云端版写入 `conflicts`，本地正文保留，`hasConflict=1`，并更新 `serverVersion`（**不**抬 `editSeq`，冲突只靠 `hasConflict` 提示）。若与本地实质相同（含自己刚上传的回声，比较时归一换行并忽略尾部空白），只更新版本与清 dirty，**不**抬 `editSeq`、**不**造冲突。
- 推送成功回写：**一律**不抬 `editSeq`；若推送期间本地又写入了更高 `editSeq`，只推进 `serverVersion`、保留更新后的正文与 dirty。推送冲突且内容实质不同才进冲突流程；文件夹套用云端结果。
- **自动触发（Must，须全部接上）：** 启动成功并已登录后；`visibility` 变为 visible；`online`；停止编辑约 **3s**；前台约每 **60s**；以及手动按钮。同一浏览器同一时刻只跑一个同步任务（多标签互斥，例如 Web Locks 或 `meta` 租约）。
- **反馈：** 自动失败静默（只改图标）；手动成功/失败用短 toast。PC 状态短文案+图标；手机主界面以图标为主。
- 实现入口：`src/lib/sync.ts`（引擎）、`src/App.tsx` / 编辑器（触发与 flush）、`SyncControls`（手动与状态）、`ConflictDialog`（三选）。

### 其它

- 登录与会话：`src/lib/supabase.ts`；冷启动用 `rememberedUser` 先开库。
- 搜索：内存索引，输入停顿约 150ms。
- 安卓：Capacitor，`android/`，同一套 Web 资源；数据在应用私有存储；卸载重装后登录再全量拉取恢复。
- 导出：设置/面板提供；导入与历史快照 UI 不挡主路径，进度里单列。

### 目录（实现落点）

```text
src/App.tsx                 壳、触发自动同步、列表与设置入口
src/components/NoteEditor.tsx   编辑与本地 flush
src/components/SyncControls.tsx 手动同步与状态
src/components/ConflictDialog.tsx
src/lib/db.ts  notes.ts  sync.ts  supabase.ts
android/   supabase/migrations/202609250001_init.sql
docs/进度.md
```

---

## 本地运行 / 检查

```powershell
pnpm install
pnpm dev
```

`.env.local`：`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`（publishable/anon）。开发可 `VITE_DEMO_MODE=true`。

```powershell
pnpm test
pnpm typecheck
pnpm build
```

发版：Cloudflare Pages，分支 `master`，`pnpm install && pnpm build`，输出 `dist`，Production 配齐上述两个 `VITE_*`。  
安卓：`pnpm cap:sync` 后 `android` 下 JDK 21+ 执行 `.\gradlew.bat assembleDebug`。
