# 目录运行手册

## 首次启用

仓库管理员在启用目录发布时完成以下配置：

1. 在 main 配置分支保护或 ruleset：必须通过 PR；至少一名维护者批准；新提交撤销旧审批；要求分支更新至最新 main。启用 `validate`（Catalog CI）和 `Trusted catalog probe`（Trusted catalog PR gate 中的作业）必需检查，尽可能将检查来源限制为 GitHub Actions；禁止强推和删除 main。
2. 等检查在工作流上实际运行后，再将对应检查设为 required。
3. 在 Settings → Pages 将 Build and deployment 的 Source 设为 GitHub Actions，并按需配置 `github-pages` 环境规则。仓库为 Public 时 Pages 和标准 Actions runner 可免费使用。
4. 手动运行 Publish workbench index，核对 Pages 返回地址下的 `/index.json`。该文件由 runner 从 `data/workbenches/*.yml` 生成，不提交到仓库。
5. 将 Pages 的 `/index.json` 地址配置给 Desktop，并单独验收读取、展示和安装；Pages 可访问不等于客户端已经接入。

不要将示例的虚构工作台放入正式目录。首次空目录可以验证部署基础设施，但不能替代真实投稿验收。

## 自动化职责

| 工作流 | 触发及作用 |
| --- | --- |
| Catalog CI | 所有 PR 和 main push：离线 Schema/example、测试和投稿范围 |
| Trusted catalog PR gate | `pull_request_target` 为每个 PR 触发可信 main 作业；通过 API 从作者 fork 只读 YAML，检查来源和截图，作业结论直接作为必需检查 |
| Publish workbench index | main push / 手动：完整探测及索引 Schema 校验，生成 `data/index.json`，上传 `data/` 并部署 Pages |
| 同一构建的每日 schedule | 重新解析 npm → Release → 源码并检查截图，全部成功后刷新 Pages 索引 |

维护者订阅该仓库 Actions 失败通知。定期更新的失败在运行记录中可见；目前不自动给作者发消息，也不自动下架。处理时区分网络/限流与确定性失效，确认后通过 PR 修复或下架。

构建只有全部探测成功才输出新的完整索引；失败不会进入部署步骤，Pages 保持上次成功版本。push 与定时/手工探测使用不同并发组，同类旧运行会被新运行替代。

## 失败与回滚

- PR 网络限流：可信检查标为失败并说明未完成，重跑 Trusted catalog PR gate，不能以 neutral 当作通过。
- 构建失败：查日志，修复原因后重跑；不要手工编辑生成 JSON。
- 回滚：在 main 通过 PR 回退对应条目或构建逻辑，再重新运行发布工作流。索引仍会重新解析 npm latest、Release latest 和默认分支，因此目录回退不等于安装版本回滚。

生产域名、客户端索引地址和告警接收人需由维护者配置，不能写入个人账号或凭据。

## Star、npm 与 Release 下载统计

安装信息完整探测成功后，发布任务为索引补充 `metrics`。GitHub API 使用同一工作流 token；npm 统计只查已验证的 npm 分发包；GitHub Release 下载数只查 `github-release` 分发，分页读取仓库 Release（最多 1000 个），累加与分发地址同名的安装包文件下载次数。请求超时 10 秒，429/5xx 最多请求 4 次，按 Retry-After（最多等待 30 秒）或指数退避；npm 新请求间至少等待 2 秒。网络异常保留旧值并标记 stale，无旧值则发布 unavailable，不影响安装目录发布。

`.cache/metrics.json` 不提交、不上传 Pages，由 Actions cache restore/save 跨运行保存。push 使用 24 小时内的成功 star 和 Release 下载缓存，npm 缓存还必须对应当前 30 天窗口；新增条目和窗口变化会触发请求。每日 03:23 UTC 和手动运行设置 `METRICS_FORCE=1` 强制更新统计。仅保留当前目录引用的仓库/包，npm 包名变化不会继承旧包的下载量。

Actions cache 可能被淘汰；冷启动遇到 API 故障会明确输出 unavailable，不能承诺永久保留历史统计。统计不是必需安装信息，因此不采用全目录覆盖率阻断发布；日志记录采集失败，客户端依据状态区分无数据与过期数据。当前目录为空，只能验证空目录发布及模拟采集；首次真实条目仍需核对 GitHub/npm 数值、Pages 输出和客户端展示。
