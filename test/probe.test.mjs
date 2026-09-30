import { enrichMetrics } from '../scripts/metrics-lib.mjs'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as tar from 'tar'
import sharp from 'sharp'
import { MAX_UNPACKED_BYTES, probeEntry, ProbeError } from '../scripts/probe-lib.mjs'
import { buildPublishedCatalog, validatePublishedCatalog } from '../scripts/published-catalog.mjs'
import { generateCatalog } from '../scripts/catalog-lib.mjs'

const pkg = { name: '@owner/workbench', version: '2.0.0', repository: 'https://github.com/owner/repo.git', exports: { './client': './client.js' }, dsh: { client: { inject: ['dsh-desktop-workbenches'] }, bundle: { patch: './cordis.patch.yml' } } }
const record = (tarball) => ({ owner: 'owner', repository: 'repo', entry: { url: 'https://github.com/owner/repo', workbenchId: 'project-helper', name: '项目助手', category: 'other', description: { zh: '帮助整理项目资料、跟进任务并生成工作报告。', en: 'Organize project materials, track tasks, and generate work reports.' }, screenshots: ['https://raw.githubusercontent.com/owner/repo/main/main.png'], ...(tarball ? { tarball } : {}) } })
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const releaseUrl = 'https://github.com/owner/repo/releases/download/v1.2.3/workbench.tgz'
const npmUrl = 'https://registry.npmjs.org/@owner/workbench/-/workbench-1.2.3.tgz'
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding)

test('permits up to 64 MiB of unpacked package contents', () => {
  assert.equal(MAX_UNPACKED_BYTES, 64 * 1024 * 1024)
})

async function archive({ version = '1.2.3', name = pkg.name, repository = pkg.repository } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-package-'))
  try {
    const root = path.join(directory, 'package')
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ ...pkg, name, version, repository }))
    await fs.writeFile(path.join(root, 'client.js'), '')
    await fs.writeFile(path.join(root, 'cordis.patch.yml'), '- insert: []')
    const file = path.join(directory, 'package.tgz')
    await tar.c({ gzip: true, cwd: directory, file }, ['package'])
    return await fs.readFile(file)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

function fixture({ bytes, npm = false, repo = {}, commitResponse = {}, packageValue = pkg, npmRepository = pkg.repository, releaseAssets } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url === 'https://api.github.com/repos/owner/repo') return json({ full_name: 'owner/repo', name: 'repo', description: 'GitHub About description', private: false, archived: false, default_branch: 'main', license: { spdx_id: 'MIT' }, ...repo })
    if (url.endsWith('/commits/main')) return json({ sha: 'a'.repeat(40), commit: { committer: { date: '2026-09-29T10:20:30Z' } }, ...commitResponse })
    if (url.endsWith('/package.json')) return json(packageValue)
    if (url.endsWith('/client.js') || url.endsWith('/cordis.patch.yml')) return new Response('source')
    if (url.endsWith('/main.png')) return new Response(await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer())
    if (url === 'https://registry.npmjs.org/%40owner%2Fworkbench/latest') return npm
      ? json({ name: pkg.name, version: '1.2.3', repository: npmRepository, dist: { tarball: npmUrl, integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` } })
      : new Response('', { status: 404 })
    if (url.endsWith('/releases/latest')) return bytes || releaseAssets ? json({ assets: releaseAssets || [{ name: 'workbench.tgz', browser_download_url: releaseUrl }] }) : new Response('', { status: 404 })
    if (url === releaseUrl || url === npmUrl) return new Response(bytes)
    throw new Error(`Unexpected URL: ${url}`)
  }
  return { fetchImpl, calls }
}

test('npm wins over Release and source; selects the published version, not the development version', async () => {
  const bytes = await archive()
  const mock = fixture({ bytes, npm: true })
  const result = await probeEntry(record(releaseUrl), mock)
  assert.equal(result.distribution.type, 'npm')
  assert.equal(result.version, '1.2.3')
  assert.equal(result.distribution.name, pkg.name)
  assert.equal(result.distribution.sha256, digest(bytes))
  assert.ok(!mock.calls.includes(releaseUrl))
  assert.ok(!mock.calls.some((url) => url.endsWith('/client.js')))
})

test('falls back to Release when npm is absent, resolving latest to a fixed asset and generated checksum', async () => {
  const bytes = await archive()
  const result = await probeEntry(record(releaseUrl), fixture({ bytes }))
  assert.equal(result.distribution.type, 'github-release')
  assert.equal(result.distribution.url, releaseUrl)
  assert.equal(result.distribution.sha256, digest(bytes))
  assert.equal(result.version, '1.2.3')
})

test('falls back to pinned source when neither npm nor Release is available', async () => {
  const mock = fixture()
  const result = await probeEntry(record(), mock)
  assert.equal(result.distribution.type, 'github-source')
  assert.equal(result.distribution.commit, 'a'.repeat(40))
  assert.equal(result.version, pkg.version)
  assert.equal(result.updatedAt, '2026-09-29T10:20:30.000Z')
  assert.ok(mock.calls.some((url) => url.includes(`/a${'a'.repeat(39)}/./client.js`)))
  assert.equal(result.screenshots[0].url, record().entry.screenshots[0])
})

test('update time is the default-branch commit date, normalized to UTC, or explicitly unavailable', async () => {
  const offset = await probeEntry(record(), fixture({ commitResponse: { commit: { committer: { date: '2026-09-29T18:20:30+08:00' } } } }))
  assert.equal(offset.updatedAt, '2026-09-29T10:20:30.000Z')
  for (const date of [undefined, 'not-a-date', '2026-02-30T10:20:30Z', '2026-09-29T25:20:30Z']) {
    const result = await probeEntry(record(), fixture({ commitResponse: { commit: { committer: { date } } } }))
    assert.equal(result.updatedAt, null)
  }
})

test('npm ownership mismatch falls back, while source package ownership must match', async () => {
  const bytes = await archive()
  const result = await probeEntry(record(releaseUrl), fixture({ bytes, npm: true, npmRepository: 'https://github.com/other/repo' }))
  assert.equal(result.distribution.type, 'github-release')
  const mock = fixture({ packageValue: { ...pkg, repository: 'https://github.com/other/repo' } })
  await assert.rejects(() => probeEntry(record(), mock), /repository/)
  assert.ok(!mock.calls.some((url) => url.startsWith('https://registry.npmjs.org')))
})

test('selected npm integrity failure blocks publication, without silent fallback', async () => {
  const bytes = await archive()
  const mock = fixture({ bytes, npm: true })
  await assert.rejects(() => probeEntry(record(releaseUrl), { fetchImpl: (url) => url === npmUrl ? new Response('corrupt') : mock.fetchImpl(url) }), /完整性/)
  assert.ok(!mock.calls.includes(releaseUrl))
})

test('rejects package identity mismatch and oversized Release', async () => {
  const bytes = await archive({ repository: 'https://github.com/other/repo' })
  await assert.rejects(() => probeEntry(record(releaseUrl), fixture({ bytes })), /repository/)
  const mock = fixture({ releaseAssets: [{ name: 'workbench.tgz', browser_download_url: releaseUrl }] })
  await assert.rejects(() => probeEntry(record(releaseUrl), { fetchImpl: (url) => url === releaseUrl ? new Response('x', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) : mock.fetchImpl(url) }), (error) => error.code === 'release-invalid' && !error.incomplete)
})

test('network failure is incomplete, not evidence that npm is absent', async () => {
  for (const status of [403, 429, 503]) {
    const mock = fixture()
    await assert.rejects(() => probeEntry(record(releaseUrl), { fetchImpl: (url) => url.startsWith('https://registry.npmjs.org') ? new Response('', { status }) : mock.fetchImpl(url) }), (error) => error instanceof ProbeError && error.incomplete)
    assert.ok(!mock.calls.includes(releaseUrl))
  }
})

test('checks repository eligibility and the package-owned install contract', async () => {
  await assert.rejects(() => probeEntry(record(), fixture({ repo: { archived: true } })), /归档/)
  await assert.rejects(() => probeEntry(record(), fixture({ repo: { license: null } })), /许可证/)
  await assert.rejects(() => probeEntry(record(), fixture({ packageValue: { ...pkg, dsh: {} } })), /bundle.patch/)
  await assert.rejects(() => probeEntry(record(), fixture({ packageValue: { ...pkg, exports: {} } })), /exports/)
  const mock = fixture()
  await probeEntry(record(), mock)
  assert.ok(!mock.calls.some((url) => url.endsWith('/workbench.json')))
})

test('market screenshots are taken only from YAML and must decode', async () => {
  const mock = fixture()
  const result = await probeEntry(record(), mock)
  assert.equal(result.screenshots.length, 1)
  assert.equal(result.screenshots[0].width, 2)
  for (const body of [new Response('', { status: 404 }), new Response('<html>wrong content</html>')]) {
    await assert.rejects(() => probeEntry(record(), { fetchImpl: (url) => url.endsWith('/main.png') ? body : mock.fetchImpl(url) }), (error) => error.code === 'invalid-image')
  }
})

test('redirected repository aliases cannot create a second catalog identity', async () => {
  await assert.rejects(() => probeEntry(record(), fixture({ repo: { full_name: 'new-owner/new-name' } })), /旧地址/)
})

test('an explicitly selected broken tarball does not silently switch to source', async () => {
  const mock = fixture({ releaseAssets: [{ name: 'workbench.tgz', browser_download_url: releaseUrl }] })
  await assert.rejects(() => probeEntry(record(releaseUrl), { fetchImpl: (url) => url === releaseUrl ? new Response('', { status: 404 }) : mock.fetchImpl(url) }), /下载失败/)
  assert.ok(!mock.calls.some((url) => url.endsWith('/client.js')))
})

test('preserves the curated market name and descriptions when repository metadata changes', async () => {
  const first = await probeEntry(record(), fixture())
  assert.equal(first.name, '项目助手')
  assert.deepEqual(first.description, record().entry.description)
  const updated = await probeEntry(record(), fixture({ repo: { name: 'Repository display', description: 'Updated About' } }))
  assert.equal(updated.name, '项目助手')
  assert.deepEqual(updated.description, record().entry.description)
  assert.equal(updated.screenshots[0].alt, '项目助手 截图 1')
  const empty = await probeEntry(record(), fixture({ repo: { name: null, description: '  ' } }))
  assert.equal(empty.name, '项目助手')
  assert.deepEqual(empty.description, record().entry.description)
})


test('resolves only the named tarball asset rather than selecting by tgz count or convention', async () => {
  const bytes = await archive()
  const tarball = 'https://github.com/owner/repo/releases/latest/download/custom.tgz'
  const releaseAssets = [
    { name: 'workbench.tgz', browser_download_url: 'https://example.com/not-selected.tgz' },
    { name: 'custom.tgz', browser_download_url: releaseUrl }
  ]
  const result = await probeEntry(record(tarball), fixture({ bytes, releaseAssets }))
  assert.equal(result.distribution.url, releaseUrl)
  await assert.rejects(() => probeEntry(record(tarball), fixture({ releaseAssets: [{ name: 'other.tgz' }] })), /指定/)
})

test('no tarball means source fallback even if the repository has release assets', async () => {
  const mock = fixture({ releaseAssets: [{ name: 'one.tgz' }, { name: 'two.tgz' }] })
  const result = await probeEntry(record(), mock)
  assert.equal(result.distribution.type, 'github-source')
  assert.ok(!mock.calls.some((url) => url.endsWith('/releases/latest')))
})

test('Release service failure cannot be treated as no available tarball', async () => {
  const mock = fixture()
  await assert.rejects(() => probeEntry(record('https://github.com/owner/repo/releases/latest/download/workbench.tgz'), { fetchImpl: (url) => url.endsWith('/releases/latest') ? new Response('', { status: 503 }) : mock.fetchImpl(url) }), (error) => error.incomplete)
})

test('published contract accepts every actual installation variant and rejects drift', async () => {
  const bytes = await archive()
  for (const [candidate, mock] of [[record(), fixture()], [record(releaseUrl), fixture({ bytes })], [record(releaseUrl), fixture({ bytes, npm: true })]]) {
    const generated = await probeEntry(candidate, mock)
    const catalog = await buildPublishedCatalog([{ record: candidate, generated }], [])
    assert.equal(catalog.kind, 'catalog')
    assert.equal(catalog.workbenches[0].updatedAt, '2026-09-29T10:20:30.000Z')
    await enrichMetrics(catalog, { sleep: async () => {}, warn: () => {}, fetchImpl: async () => { throw new Error('offline') } })
    await validatePublishedCatalog(catalog)
    const missingUpdate = structuredClone(catalog)
    delete missingUpdate.workbenches[0].updatedAt
    await validatePublishedCatalog(missingUpdate)
    const unavailableUpdate = structuredClone(catalog)
    unavailableUpdate.workbenches[0].updatedAt = null
    await validatePublishedCatalog(unavailableUpdate)
    const invalidUpdate = structuredClone(catalog)
    invalidUpdate.workbenches[0].updatedAt = 'yesterday'
    await assert.rejects(() => validatePublishedCatalog(invalidUpdate), /协议/)
    catalog.workbenches[0].metrics.githubStars = { value: 0, checkedAt: '2026-09-21T00:00:00Z', status: 'ok' }
    catalog.workbenches[0].metrics.npmDownloads30d = { value: 4, checkedAt: '2026-09-21T00:00:00Z', status: 'stale', start: '2026-08-22', end: '2026-09-20' }
    catalog.workbenches[0].metrics.githubReleaseDownloads = { value: 9, checkedAt: '2026-09-21T00:00:00Z', status: 'ok' }
    await validatePublishedCatalog(catalog)
    const badMetrics = structuredClone(catalog)
    badMetrics.workbenches[0].metrics.githubStars = { value: -1, checkedAt: null, status: 'ok' }
    await assert.rejects(() => validatePublishedCatalog(badMetrics), /协议/)
    const badReleaseMetrics = structuredClone(catalog)
    badReleaseMetrics.workbenches[0].metrics.githubReleaseDownloads = { value: 3, checkedAt: null, status: 'not_applicable' }
    await assert.rejects(() => validatePublishedCatalog(badReleaseMetrics), /协议/)

    assert.deepEqual(catalog.workbenches[0].description, candidate.entry.description)
    const invalid = structuredClone(catalog)
    invalid.workbenches[0].version = '9.9.9'
    await assert.rejects(() => validatePublishedCatalog(invalid), /版本/)
    delete invalid.workbenches[0].distribution
    await assert.rejects(() => validatePublishedCatalog(invalid), /协议/)
  }
})

test('an unprobed generated structure cannot be published', async () => {
  await assert.rejects(() => validatePublishedCatalog(generateCatalog([], [])), /协议/)
  await assert.rejects(() => buildPublishedCatalog([{ record: record(), error: { status: 'incomplete' } }], []), /未完成/)
  assert.equal((await buildPublishedCatalog([], [])).kind, 'catalog')
})
