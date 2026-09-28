# Awesome DSH Workbench

DSH Desktop 工作台目录：作者通过 Pull Request 提交工作台 YAML，维护者审核后，由流水线生成可追溯的目录。源码、安装包和图片保留在作者仓库。

合并到 main 后，流水线从 `data/workbenches/*.yml` 生成 `data/index.json`，并通过 GitHub Pages 发布。Desktop 客户端接入仍需独立验收。

## 投稿

1. 按目标宿主的真实工作台接口开发，在本机安装、打开并验证。
2. 阅读[三条最短投稿路径](CONTRIBUTING.md#三条最短投稿路径)，复制 [YAML 示例](examples/workbench.yml)。
3. 替换全部占位内容，保存为 `data/workbenches/<owner>__<repo>.yml`。截图声明与工作台信息放在同一文件。
4. 执行 `npm ci --ignore-scripts && npm run check`，提交一个工作台的 PR。
5. 通过自动检查和维护者审核，合并并成功发布后，才算进入公开目录。

GitHub 仓库地址确定条目唯一性，安装优先选择 npm，其次使用可选声明的 Release 安装包，最后回退源码。版本、commit 和校验值由构建解析；作者正常发版无需逐版本提交目录 PR。

## 规范入口

- [目录字段与图片标准](catalog/README.md)
- [投稿与维护者审核](CONTRIBUTING.md)
- [发布、巡检和回滚](docs/operations.md)

目录 YAML 是市场元数据协议，不是宿主运行时 manifest；不能直接导入 Desktop 充当工作台包。收录不等于安全审计，也不代表所有平台已经验证。
