# 工作台投稿指南

## 首次收录

1. 按目标 Desktop 的真实工作台接口开发，在本机安装、打开并验证。源码、许可证、图片、使用说明和安装包保留在自己的公开仓库。
2. 复制 [example](examples/workbench.yml)，填写仓库、展示名称、分类、中英文介绍与最终可安装版本实拍的截图 HTTPS 地址，保存为 `data/workbenches/<owner>__<repo>.yml`。
3. 无需手填 ID、版本、commit、npm 包名或校验值，也无需新增 `workbench.json`。目录使用 GitHub 仓库身份，自动从 `package.json` 按 **npm → Release → 源码** 选择并验证安装来源。名称填写 name，用于市场列表页展示；有明确的预构建包时可选填 tarball URL，无需填写版本或校验值。新投稿不填 `workbenchId`；旧 YAML 若保留该兼容字段，必须等于由仓库派生的 `wb-<owner>-<repo>`。双语介绍填写 description.zh 和 description.en，均为非空单行。
4. 执行 `npm ci --ignore-scripts && npm run check`。本地检查验证格式、example、测试和离线生成；远程来源与图片由可信 CI 实际检查。
5. 从自己的 fork 向本仓库 main 提交 PR，只新增或修改这一份 YAML；实测环境、安装与卸载步骤、权限、服务费用、授权和已知限制写在 PR 描述及作者 README，不塞进目录协议。
6. PR 已提交表示待检查；PR 已合并表示代码进入 main；合并后发布任务成功且公开索引可查，才报告市场可见。目录 artifact 不等于 Desktop 已接入在线市场。

## 三条最短投稿路径

三种来源使用相同的最小 YAML，保存为 `data/workbenches/owner__repo.yml`：

```yaml
url: https://github.com/owner/repo
name: 项目助手
category: productivity
description:
  zh: 帮助整理项目资料、跟进任务并生成工作报告。
  en: Organize project materials, track tasks, and generate work reports.
screenshots:
  - https://raw.githubusercontent.com/owner/repo/main/docs/images/overview.webp
```

- **仅源码**：公开仓库根目录准备好 `package.json`、bundle patch 和客户端入口 → 从该源码版本本机安装、实拍截图 → 提交上述 YAML。市场探测固定默认分支 commit。
- **GitHub Release**：完成同一包协议并上传 `.tgz` 或 `.tar.gz` → 从最终 Release 包本机安装、实拍截图 → 在上述 YAML 增加 `tarball: https://github.com/owner/repo/releases/download/v1.0.0/workbench.tgz`，或使用 `releases/latest/download/<资源名>`。若 npm 包也符合条件，npm 仍优先。
- **npm**：发布符合包协议且 `repository` 指回该仓库的 npm 包 → 从正式 npm 版本本机安装、实拍截图 → 提交上述 YAML，不填 npm 名称或版本。市场从源码 `package.json.name` 发现并校验 npm `latest`。

上述地址与内容均为占位示例；投稿前替换为真实仓库和最终可安装版本的截图。三条路径均执行 `npm ci --ignore-scripts && npm run check`，并从 fork 向 main 提交 PR。**PR 已提交**只是待检查，**PR 已合并**只是进入 main，发布成功且公开 `/index.json` 可查后才是**市场可见**。

包格式与开发指南见[目录协议](catalog/README.md#包与宿主)。实测记录必须真实，未验证项明确标出。

## 后续维护

- 作者自行测试并发布 npm 新版本，目录定期解析 npm `latest`，无需每次目录 PR。
- Release 包用 tarball 明确指定，固定 tag 更新需 PR；使用 latest/download/资源名时跟随同名资源，不规定作者的包文件名。
- 源码更新及原路径图片内容更新自动发现，目录每次生成都固定当次 commit 和安装包校验值。
- 展示名称由 YAML 的 name 维护；名称、分类、双语介绍、仓库地址、tarball 或图片地址/顺序改变时，提交 YAML 更新 PR。
- 后续自动探测不是逐版本人工验收。权限、费用、使用限制及变更说明需在作者仓库保持最新。

## PR 范围

| 类型 | 要求 |
| --- | --- |
| 新增 / 目录信息修改 | 一份工作台 YAML，自动探测 + 维护者审批 |
| 下架 | 单独删除一份 YAML，说明原因和影响；维护者审批 |
| 仓库维护 | Schema、脚本、工作流、文档等，完整检查；不混入工作台投稿 |

不提交生成目录、图片二进制、安装包、凭据、个人邮箱或业务数据。作者不能自行声明审核通过；新提交需要重新检查。

网络限流或失败表示本次未验证，不能算通过。合并保护、发布和巡检见[运行手册](docs/operations.md)。

## 维护者审核

维护者在最新 head 的 PR review 中记录「通过 / 待补充 / 未通过」，以及实测版本、环境、结果和未验证项。

- 检查 PR 范围、仓库归属、来源及资源授权；展示名称、双语介绍和截图应与实际功能一致。
- 确认最新 PR 的 Catalog CI 与 Trusted catalog probe 作业确实运行并通过，日志显示来源和截图探测；跳过、找不到 PR 或旧 head 均不算通过；网络错误表示未完成验证。
- 首次收录或安装来源变更时，核对实际安装来源，在记录的 Desktop/系统版本上验证安装、打开和基本功能；核对卸载说明、权限、外部服务及费用。自动探测不执行工作台代码，不能代替实测。
- 文案或图片修改审核对应内容；下架需说明原因和影响，不会自动卸载用户本机工作台或删除数据。
- 审批后新增提交需重新确认。普通发版由自动探测处理，不代表逐版本人工验收。

合并后核对发布工作流及线上目录的 commit/校验值。发布失败按[运行手册](docs/operations.md)处理。
