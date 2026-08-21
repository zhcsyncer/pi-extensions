# Herdr Companion

状态：已落地。`herdr_worker` 实现保留、不注册。`/herdr-worktree` 实现 `start` 与 `cleanup`。

## 为什么做

Pi 在 Herdr 里缺三件用户能看见的事：长跑命令要占一扇可见 Pane、临时问题要另开对话、blocked 要报到 Herdr。Companion 只在 caller 身份完整时启用；外面保持静默，避免半残工具露出来。

根 bundle 内嵌源码但不启用：这是环境相关扩展，不该在非 Herdr 会话里自动出现。

`/btw` 改编自 `pi-herdr-btw` 0.3.0 的产品行为；进程所有权、blocked 和统一设置是本包的边界，不跟上游绑在一起。

## 心智模型

- **进程认的是同一 Herdr server 里的 live terminal**，不是当时的 pane ID。挪到别的 Tab / Workspace 后继续跟；跨 socket 或冷启动后的旧所有权丢掉，不套到另一块 terminal 上。
- **`/btw` 是临时可见支线**，不是可恢复 session。合回是用户动作。父子共享 cwd，所以文件、Git、端口会互相踩。
- **`/herdr-config` 先改草稿**。Save 才写 `extension-data/pi-herdr-companion/config.json`；Discard 等于没打开；Reset draft 只重置草稿。`/herdr-config reset` 才立刻打回已保存文件。
- **`/herdr-worktree start` 先整理、后派出**。整理在命令里单独调模型，不走 session agent run，确认前不写 transcript。结果只进多行编辑器；保存后才建树，transcript 只留 `[已派出]`。子 session 只拿到最终那份计划。
- **`/herdr-worktree cleanup` 认的是当前 Herdr workspace 那棵 linked worktree**，不是模型现场拼的 git。身份来自 `HERDR_WORKSPACE_ID` + `herdr workspace get` 的 `worktree.is_linked_worktree`；分支和脏树只看这棵 checkout 上的可控 git。

## 红线

- 生命周期清理核验失败时留 orphan，不关 caller，也不关别人的 Pane。
- `herdr_process stop` 只关自己创建的 Pane。
- 不要同时加载另一个 `/btw`。
- `herdr_worker` 不进工具面：用 sysprompt 当回调合同，会漏进 `Agent` / subagent，上报会乱。实现留在 `src/worker.ts`，扩展启动时不注册。
- Companion 不替代 Herdr 的 Pi integration。
- `/herdr-worktree start` 不打包主对话，不对已有树上的 Pi 再说话，不等子 session 做完。目标分支是 `main` / `master`、计划为空、或该分支已有 linked worktree 时硬拒绝。确定性顺序是 `worktree create --focus` → `agent start --kind pi` → `agent prompt --wait --until working`。不要把 `--keep-branch` 传给 Herdr。
- `/herdr-worktree cleanup` 硬拒绝 `main` / `master`、primary checkout、脏树；不问 squash / MR / `merge-base`。默认顺序必须是 `git checkout --detach` → 当前 worktree 里 `git branch -D` → 最后 `herdr worktree remove --workspace <id>`。`--keep-branch` 跳过前两步。不要先 `workspace close`，也不要把还不存在的 `--keep-branch` 传给 Herdr。远程分支默认不动。

## 非显然外部事实

- 核心进程管理需要 Herdr 0.7.5+，开发对照 0.8.0。
- POSIX 默认走私有 Bash 脚本，是因为 Fish 等 interactive pane shell 会改写模型写的 Bash。
