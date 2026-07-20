# Release

- 发版必须走 Changesets 的 version PR 流程：用户可见变更先附带 changeset 合入 `main`，等待 `.github/workflows/release.yml` 创建或更新 `chore: version packages` PR，审核并合并该 PR 后再由 GitHub Actions 发布。
- 不要直接运行版本升级或发布命令，也不要绕过 version PR 直接向 `main` 提交发版版本、推送发布 tag 或手动发布 npm 包。
- 发版前必须先向用户列出计划更新的包、当前版本和目标版本，并等待用户明确 review/确认；确认前不得将发版变更推送到 `main`、合并 version PR 或触发发布。
