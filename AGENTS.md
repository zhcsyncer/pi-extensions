# Release

- 发版必须走 Changesets 的 version PR 流程：用户可见变更先附带 changeset 合入 `main`，等待 `.github/workflows/release.yml` 创建或更新 `chore: version packages` PR，审核并合并该 PR 后再由 GitHub Actions 发布。
- 不要直接运行版本升级或发布命令，也不要绕过 version PR 直接向 `main` 提交发版版本、推送发布 tag 或手动发布 npm 包。
