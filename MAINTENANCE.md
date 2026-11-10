# 维护约定：上游同步与自有开发

本仓库是 [shy3130/tick-stock-panel](https://github.com/shy3130/tick-stock-panel) 的 fork。上游更新非常频繁（2026-10-26 → 11-10 走了 100+ 提交，版本 v0.3.17 → v0.3.35）。为了让「随时吃上游更新」和「长期维护自己的改造」互不干扰，采用**一个 fork、两条分支**。

项目内的详细说明见 `docs/`，本文件只约定这个 fork 自己的维护纪律。

## 分支职责

| 分支 | 内容 | 谁更新 | 纪律 |
|---|---|---|---|
| `main`（默认） | 与上游 `shy3130:main` 内容一致 | Sync fork / `gh repo sync -b main` | **永不提交自己的代码**，永远保持 `ahead_by = 0` |
| `custom` | `main` + 我们所有的板块改造 | PR 合并、上游 merge | 所有 PR 的 base，**开发主线** |
| `feat/*` | 单次改动 | `ghflow pr` | 合并后删除 |

### 为什么不用两个 repo

fork 的价值是**血缘**：Sync fork 一键 fast-forward、compare 看上游改了什么。另开一个独立 repo 会切断血缘，上游每次更新都要手工搬几百个文件。而上游确实改过 `frontend/src/extensions/types.ts`、`registry.ts`、`runtime.tsx` —— 扩展能不能继续加载，全靠能看见这些 diff。

那个「干净的原始工具」不需要自己留一份：上游仓库本身就是，官方 release 也随时可装。

### 为什么不让 main 带改造、另开镜像分支

网页的 Sync fork 只作用于默认分支，反过来会绕。保持 `main` 纯净，Sync fork 才永远能 fast-forward；一旦 `main` 有了自己的 commit，GitHub 会提示解冲突甚至不允许同步。

## 上游同步流程

1. **同步远程 main**
   ```bash
   gh repo sync vanvani/tick-stock-panel -b main
   ```
   等价 API：`POST /repos/vanvani/tick-stock-panel/merge-upstream`，body `{"branch":"main"}`。

2. **本地 main 追上**（本机沙箱 git 协议不通，走 API 增量）
   ```bash
   upstream-delta shy3130/tick-stock-panel ~/Projects/tick-stock-panel <上次已知的上游 sha>
   git add -A && git commit -m "chore: 同步上游 <旧sha>..<新sha>"
   ```

3. **本地 custom 吃更新**
   ```bash
   git checkout custom && git merge main --no-edit
   ```

4. **远程 custom 吃更新**
   `POST /repos/vanvani/tick-stock-panel/merges`，body `{"base":"custom","head":"main"}`。

5. **验证**
   ```bash
   GHFLOW_BASE=custom ghflow status      # 内容与远程一致
   pnpm exec tsc --noEmit -p tsconfig.json
   pnpm build
   ```
   最后两项是必须的：扩展加载器失败时只打一条 warning 并禁用该扩展，**不会报错**，契约变更可能让扩展静默失效。

> 第 4 步用 merge 以保留上游历史血缘；PR 合并仍按全局公约走 squash。两者用途不同，不冲突。

## 日常开发

```bash
cd ~/Projects/tick-stock-panel
git checkout custom

# 改完代码，开 PR（base 自动是 custom）
GHFLOW_BASE=custom ghflow pr -m "feat(hk): ..." -b "改了什么 / 影响什么 / 怎么回滚"

# 用户批准「提交合并」后
GHFLOW_BASE=custom ghflow merge <PR号>
```

纯文案 / 参数微调走 `GHFLOW_BASE=custom ghflow fast`。`GHFLOW_BASE` 缺省时 ghflow 仍以仓库默认分支为基线，其他项目不受影响。

## 改造形态

优先做成自包含扩展，零核心改动：

- 后端 `backend/app/custom/<namespace>/`：`EXTENSION_ID` + `EXTENSION_API_VERSION` + `setup(registrar)`
- 前端 `frontend/src/custom/<namespace>/extension.tsx`：`import.meta.glob` 自动发现
- 卸载 = 删掉这两个目录

样板看 `backend/app/custom/paper_execution/` 与 `frontend/src/custom/paper/`。

## 落地记录

- 2026-11-11：从「PR #1 base = main」调整为 `main` 纯镜像 + `custom` 开发主线；PR #1 squash 合入 `custom`；同步上游 v0.3.27 → v0.3.35 并合入 `custom`。约定同时写入 WorkBuddy 工作区记忆与用户级长期记忆。
