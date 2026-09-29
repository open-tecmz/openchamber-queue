# Changelog

本项目的所有变更都记录在此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 优化

- 优化：任务输入框高度随内容自动增长，并设置最大高度，超出部分在框内滚动。
- 优化：后台队列状态改存到独立目录 `~/.config/openchamber-queue/state.json`，并支持通过 `OPENCHAMBER_QUEUE_DATA_DIR` 自定义。
- 优化：README 增加居中标题、徽章、功能截图与目录导航，并同步更新数据目录说明。
- 优化：中文 README 同步居中标题、徽章、功能截图与目录导航。
- 优化：中英文 README 的目录结构补齐 AGENTS.md、changelog.md 与两份 README，并在开发章节说明需维护变更记录。
- 优化：新增 AGENTS.md 项目规范，约定每次改动都需更新 changelog.md。
- 优化：项目许可证由 MIT 变更为 Apache 2.0。
- 优化：GitHub Actions 打包改为 main 分支发布滚动 `latest` 包并标记为最新，推送 `vX.Y.Z` tag 时发布对应版本包，两者都刷新 `release` 分支。
