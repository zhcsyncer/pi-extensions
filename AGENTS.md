# Documentation

- 维护中的用户可见包文档必须提供双语版本：英文使用默认 `README.md`，简体中文使用 `README.zh-CN.md`；只有仓库中明确记录的例外可以省略该规则。
- 用户可见包 README 只写来源与上游差异、核心功能和用法，让用户尽快上手。不要写扩展自身的设计说明、实现细节、存储布局、刷新策略或本地开发步骤；那些留在 [`docs/`](./docs/README.md)。新方案按包切片放进 `docs/<package>/`，不再堆在仓库根或包内 `docs/`。

# Release

- 发版必须走 Changesets 的 version PR 流程：用户可见变更先附带 changeset 合入 `main`，等待 `.github/workflows/release.yml` 创建或更新 `chore: version packages` PR，审核并合并该 PR 后再由 GitHub Actions 发布。
- 不要直接运行版本升级或发布命令，也不要绕过 version PR 直接向 `main` 提交发版版本、推送发布 tag 或手动发布 npm 包。
- 准备发布根包 `@zhcsyncer/pi-extensions` 时，先检查并处理 [`BACKLOG.md`](./BACKLOG.md) 中标记为下一次根包发布前完成的未勾选事项。
- 发版前必须先向用户列出计划更新的包、当前版本和目标版本，并等待用户明确 review/确认；确认前不得将发版变更推送到 `main`、合并 version PR 或触发发布。
