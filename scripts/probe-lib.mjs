import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import semver from 'semver'
import { safeRelativePath, screenshotUrl } from './catalog-lib.mjs'
import { inspectImage, readBounded, MAX_IMAGE_BYTES, MAX_PACKAGE_BYTES } from './media-lib.mjs'

export class ProbeError extends Error {
  constructor(code, message, { incomplete = false } = {}) {
    super(message)
    this.code = code
    this.incomplete = incomplete
  }
}

export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

async function responseJson(response, label) {
  if (response.status === 403 || response.status === 429) throw new ProbeError('rate-limited', `${label} 遇到 GitHub 限流`, { incomplete: true })
  if (!response.ok) throw new ProbeError('unavailable', `${label} 请求失败（HTTP ${response.status}）`, { incomplete: response.status >= 500 })
  return JSON.parse((await readBounded(response, 1024 * 1024, label)).toString())
}

function sameRepository(value, owner, repository) {
  const raw = typeof value === 'string' ? value : value?.url
  if (typeof raw !== 'string') return false
  const normalized = raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase()
  return normalized === `https://github.com/${owner}/${repository}`.toLowerCase()
}

function clientEntry(pkg) {
  const value = pkg?.exports?.['./client']
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['import', 'default']) if (typeof value[key] === 'string') return value[key]
  }
}

export function validatePackage(pkg, { owner, repository } = {}) {
  const errors = []
  if (typeof pkg?.name !== 'string' || !pkg.name.trim()) errors.push('package.json 缺少 name')
  if (!pkg?.version || semver.valid(pkg.version) !== pkg.version) errors.push('package.json version 必须为完整 SemVer')
  if (owner && repository && !sameRepository(pkg.repository, owner, repository)) errors.push('package.json repository 必须指向条目仓库')
  if (!Array.isArray(pkg?.dsh?.client?.inject) || !pkg.dsh.client.inject.includes('dsh-desktop-workbenches')) errors.push('client 必须注入 dsh-desktop-workbenches')
  if (!safeRelativePath(pkg?.dsh?.bundle?.patch, { allowDotPrefix: true })) errors.push('缺少安全的 dsh.bundle.patch 路径')
  const entry = clientEntry(pkg)
  if (!safeRelativePath(entry, { allowDotPrefix: true })) errors.push('缺少安全的 exports["./client"] 客户端入口')
  if (errors.length) throw new ProbeError('invalid-manifest', errors.join('；'))
  return { entry, patch: pkg.dsh.bundle.patch }
}

async function fetchJsonFile(fetchImpl, owner, repository, sha, name, required = true) {
  const response = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repository}/${sha}/${name}`)
  if (!response.ok) {
    if (!required && response.status === 404) return null
    throw new ProbeError('invalid-manifest', `${name} 不存在或不可读取`, { incomplete: response.status === 429 || response.status >= 500 })
  }
  try { return JSON.parse((await readBounded(response, 256 * 1024, name)).toString()) } catch { throw new ProbeError('invalid-manifest', `${name} 不是有效 JSON`) }
}

async function inspectPackage(fetchImpl, url, { expectedVersion, expectedName, integrity, owner, repository } = {}) {
  const response = await fetchImpl(url)
  if (!response.ok) throw new ProbeError('release-unavailable', `Release 下载失败（HTTP ${response.status}）`, { incomplete: response.status === 429 || response.status >= 500 })
  let bytes
  try { bytes = await readBounded(response, MAX_PACKAGE_BYTES, 'Release 包（上限 8 MiB）') }
  catch (error) { throw new ProbeError('release-invalid', error.message) }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (integrity) {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
    if (!match || crypto.createHash('sha512').update(bytes).digest('base64') !== match[1]) throw new ProbeError('package-mismatch', 'npm 包完整性校验失败')
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-release-'))
  const archive = path.join(directory, 'package.tgz')
  const unpacked = path.join(directory, 'unpacked')
  await fs.writeFile(archive, bytes)
  await fs.mkdir(unpacked)
  const names = []
  let packageManifest
  try {
    let expandedBytes = 0
    await tar.t({ file: archive, sync: true, onentry: (entry) => {
      names.push(entry.path)
      if (!['File', 'Directory'].includes(entry.type)) throw new Error(`不允许 ${entry.type} 条目`)
      expandedBytes += entry.size || 0
      if (entry.size > 8 * 1024 * 1024 || expandedBytes > MAX_UNPACKED_BYTES || names.length > 500) throw new Error('解包内容超过安全上限')
    } })
    if (names.some((name) => !safeRelativePath(name.replace(/\/$/, '')))) throw new Error('包含不安全路径')
    await tar.x({ file: archive, cwd: unpacked, strict: true, preservePaths: false })
    const manifests = names.filter((name) => /(^|\/)package\.json$/.test(name)).sort((a, b) => a.split('/').length - b.split('/').length)
    const manifestName = manifests[0]
    if (!manifestName || (manifests[1] && manifests[1].split('/').length === manifestName.split('/').length)) throw new Error('包必须包含唯一的顶层 package.json')
    const root = path.dirname(path.join(unpacked, manifestName))
    const pkg = JSON.parse(await fs.readFile(path.join(unpacked, manifestName), 'utf8'))
    const contract = validatePackage(pkg, { owner, repository })
    if (!(await fs.stat(path.join(root, contract.patch)).catch(() => null))?.isFile()) throw new Error('Release 包缺少 bundle patch 文件')
    const entry = path.resolve(root, contract.entry)
    const relative = path.relative(root, entry)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(entry).catch(() => null))?.isFile()) {
      throw new ProbeError('release-invalid', 'Release 包中的 entry 不存在或路径不安全')
    }
    if ((expectedVersion && pkg.version !== expectedVersion) || (expectedName && pkg.name !== expectedName)) throw new ProbeError('package-mismatch', '安装包版本或包名与来源不一致')
    packageManifest = pkg
  } catch (error) {
    if (error instanceof ProbeError) throw error
    throw new ProbeError('release-invalid', `Release 包检查失败：${error.message}`)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
  return { sha256: digest, bytes: bytes.length, version: packageManifest.version }
}

async function resolveDistribution(fetchImpl, entry, owner, repository, commit, pkg, contract) {
  if (pkg.name && sameRepository(pkg.repository, owner, repository)) {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`)
    if (response.status !== 404) {
      const published = await responseJson(response, 'npm')
      if (published.name === pkg.name && sameRepository(published.repository, owner, repository)) {
        const url = new URL(published.dist?.tarball || '')
        if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.hash) throw new ProbeError('invalid-npm', 'npm 安装包必须来自官方 registry')
        if (!semver.valid(published.version) || typeof published.dist?.integrity !== 'string') throw new ProbeError('invalid-npm', 'npm 缺少版本或完整性校验值')
        const checked = await inspectPackage(fetchImpl, url.href, { expectedName: pkg.name, expectedVersion: published.version, integrity: published.dist.integrity, owner, repository })
        return { type: 'npm', name: pkg.name, url: url.href, integrity: published.dist.integrity, ...checked }
      }
    }
  }
  if (entry.tarball) {
    let url = entry.tarball
    if (url.includes('/releases/latest/download/')) {
      const requested = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
      const release = await responseJson(await fetchImpl(`https://api.github.com/repos/${owner}/${repository}/releases/latest`), 'GitHub Release')
      if (!Array.isArray(release.assets) || release.draft || release.prerelease) throw new ProbeError('release-invalid', '最新正式 Release 元数据无效')
      const candidates = release.assets.filter((asset) => asset.name === requested)
      if (candidates.length !== 1) throw new ProbeError('release-unavailable', '最新正式 Release 未找到 tarball 指定的唯一资源')
      url = candidates[0].browser_download_url
    }
    const parsed = new URL(url)
    if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || !parsed.pathname.toLowerCase().startsWith(`/${owner}/${repository}/releases/download/`.toLowerCase()) || parsed.search || parsed.hash) throw new ProbeError('release-invalid', 'tarball 必须解析为同仓库的固定版本资源')
    return { type: 'github-release', url, ...await inspectPackage(fetchImpl, url, { owner, repository }) }
  }
  for (const file of [contract.patch, contract.entry]) {
    const response = await fetchImpl(sourceFileUrl(owner, repository, commit, file))
    if (!response.ok) throw new ProbeError('invalid-manifest', `源码缺少 ${file}`, { incomplete: response.status >= 500 || response.status === 429 })
    await readBounded(response, MAX_PACKAGE_BYTES, file)
  }
  return { type: 'github-source', url: entry.url.replace(/\/$/, ''), commit, version: pkg.version }
}

function sourceFileUrl(owner, repository, commit, file) {
  return `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`
}

function normalizeCommitDate(value) {
  if (typeof value !== 'string') return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts) return null
  const [, year, month, day, hour, minute, second, zone] = parts
  const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
    || +hour > 23 || +minute > 59 || +second > 59 || offsetHours > 23 || offsetMinutes > 59) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

export async function probeEntry(record, { fetchImpl = fetch } = {}) {
  const originalFetch = fetchImpl
  fetchImpl = (url, options = {}) => originalFetch(url, { ...options, signal: AbortSignal.timeout(30_000) })
  const { entry, owner, repository } = record
  const repo = await responseJson(await fetchImpl(`https://api.github.com/repos/${owner}/${repository}`), '仓库')
  if (typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== `${owner}/${repository}`.toLowerCase()) throw new ProbeError('repository-moved', '请使用 GitHub 当前仓库主页，不能通过旧地址重复收录')
  if (repo.private) throw new ProbeError('unavailable', '仓库不是公开仓库')
  if (repo.archived) throw new ProbeError('archived', '仓库已归档')
  if (!repo.license?.spdx_id || repo.license.spdx_id === 'NOASSERTION') throw new ProbeError('missing-license', '仓库没有可识别的许可证')
  const commit = await responseJson(await fetchImpl(`https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(repo.default_branch)}`), '源码 commit')
  if (!/^[a-f0-9]{40}$/.test(commit.sha || '')) throw new ProbeError('unavailable', '未解析到完整源码 commit')
  const pkg = await fetchJsonFile(fetchImpl, owner, repository, commit.sha, 'package.json')
  const contract = validatePackage(pkg, { owner, repository })
  const name = entry.name
  const distribution = await resolveDistribution(fetchImpl, entry, owner, repository, commit.sha, pkg, contract)
  const screenshots = []
  for (const [index, image] of entry.screenshots.entries()) {
    const url = screenshotUrl(image, owner, repository)
    const response = await fetchImpl(url)
    if (!response.ok) throw new ProbeError('invalid-image', `截图不可读取：${image}`, { incomplete: response.status === 429 || response.status >= 500 })
    try {
      const bytes = await readBounded(response, MAX_IMAGE_BYTES, image)
      const dimensions = await inspectImage(bytes, new URL(url).pathname)
      screenshots.push({ url, alt: `${name} 截图 ${index + 1}`, ...dimensions, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    } catch (error) { throw new ProbeError('invalid-image', `${image}: ${error.message}`) }
  }
  return {
    name,
    description: entry.description,
    version: distribution.version,
    distribution,
    screenshots,
    sourceCommit: commit.sha,
    updatedAt: normalizeCommitDate(commit.commit?.committer?.date),
    license: repo.license.spdx_id,
    probe: { status: 'ok' }
  }
}

export async function probeAll(records, options = {}) {
  const results = []
  for (const record of records) {
    try {
      results.push({ record, generated: await probeEntry(record, options) })
    } catch (error) {
      const failure = error instanceof ProbeError ? error : new ProbeError('probe-error', error.message, { incomplete: true })
      results.push({ record, error: { code: failure.code, message: failure.message, status: failure.incomplete ? 'incomplete' : 'failed' } })
    }
  }
  return results
}
