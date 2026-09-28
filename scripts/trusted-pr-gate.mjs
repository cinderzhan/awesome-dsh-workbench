#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createValidator, readEntry, loadEntries, DATA_DIR } from './catalog-lib.mjs'
import { probeEntry } from './probe-lib.mjs'
import { readBounded } from './media-lib.mjs'
import { classifyChanges } from './pr-policy.mjs'
import { buildPublishedCatalog } from './published-catalog.mjs'

// Run only from trusted main code in pull_request_target. Never check out or execute PR files.
export async function runGate({ env = process.env, fetchImpl = fetch, dataDir = DATA_DIR } = {}) {
  const { GITHUB_TOKEN: token, REPOSITORY: repository, PR_NUMBER: number, CANDIDATE_SHA: sha } = env
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[1-9]\d*$/.test(number || '') || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('缺少可信运行上下文')
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
  const api = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`GitHub API ${url} 返回 ${response.status}`)
    return response.json()
  }
  const pullUrl = `https://api.github.com/repos/${repository}/pulls/${number}`
  const pull = await api(pullUrl)
  const assertCurrent = (p) => {
    if (p.number !== Number(number) || p.state !== 'open' || p.base?.ref !== 'main' || p.base?.repo?.full_name !== repository || p.head?.sha !== sha || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.head?.repo?.full_name || '')) throw new Error('找不到当前 main PR，或候选 head 已更新；本次探测未完成')
  }
  assertCurrent(pull)
  const files = []
  for (let page = 1; ; page++) {
    const batch = await api(`${pullUrl}/files?per_page=100&page=${page}`)
    files.push(...batch)
    if (batch.length < 100) break
    if (page >= 30) throw new Error('PR 文件过多，无法完整审核')
  }
  const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pull.author_association)
  const policy = classifyChanges(files, { allowCatalogMaintenance: trusted })
  if (policy.type !== 'submission') {
    await api(pullUrl).then(assertCurrent)
    console.log(policy.type === 'removal' ? '下架范围检查通过；仍需维护者审批。' : '仓库维护 PR：范围检查通过，Catalog CI 负责离线测试。')
    return { type: policy.type }
  }

  const { candidate } = policy
  const sourceUrl = `https://api.github.com/repos/${pull.head.repo.full_name}/contents/${candidate.filename}?ref=${sha}`
  const response = await fetchImpl(sourceUrl, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`无法读取 fork 或分支中的候选 YAML（HTTP ${response.status}）`)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-candidate-'))
  try {
    const file = path.join(directory, path.basename(candidate.filename))
    await fs.writeFile(file, await readBounded(response, 32 * 1024, '候选 YAML'), { flag: 'wx' })
    const record = await readEntry(file, await createValidator())
    await fs.cp(dataDir, path.join(directory, 'catalog'), { recursive: true })
    await fs.copyFile(file, path.join(directory, 'catalog', path.basename(file)))
    await loadEntries({ directory: path.join(directory, 'catalog') })
    const generated = await probeEntry(record, { fetchImpl: (url, options = {}) => fetchImpl(url, {
      ...options,
      headers: url.startsWith('https://api.github.com/') ? { ...options.headers, Authorization: `Bearer ${token}` } : options.headers
    }) })
    await buildPublishedCatalog([{ record, generated }], [])
    await api(pullUrl).then(assertCurrent)
    console.log('仓库、截图和安装来源探测通过；仍需维护者核对本机实测记录。')
    return { type: 'submission' }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runGate().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
