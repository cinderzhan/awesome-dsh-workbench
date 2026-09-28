import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runGate } from '../scripts/trusted-pr-gate.mjs'
import { ROOT } from '../scripts/catalog-lib.mjs'

const sha = 'c'.repeat(40)
const env = { GITHUB_TOKEN: 'test-token', REPOSITORY: 'catalog/repo', PR_NUMBER: '3', CANDIDATE_SHA: sha }
const pull = { number: 3, state: 'open', base: { ref: 'main', repo: { full_name: 'catalog/repo' } }, head: { sha, repo: { full_name: 'author/fork' } }, author_association: 'CONTRIBUTOR' }
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function apiMock({ current = pull, files = [], source = '', probeFailure = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/pulls/3')) return json(current)
    if (url.includes('/pulls/3/files?')) return json(files)
    if (url.includes('/contents/')) return new Response(source)
    if (probeFailure) return new Response('', { status: 503 })
    throw new Error(`unexpected request: ${url}`)
  }
  return { fetchImpl, calls }
}

test('fork maintenance is checked by the trusted job without executing code', async () => {
  const mock = apiMock({ files: [{ filename: 'README.md', status: 'modified' }] })
  assert.deepEqual(await runGate({ env, ...mock }), { type: 'maintenance' })
  assert.ok(!mock.calls.some((url) => url.includes('/contents/')))
})

test('missing PR and stale fork head fail instead of succeeding', async () => {
  for (const current of [{ ...pull, head: { ...pull.head, sha: 'd'.repeat(40) } }, { ...pull, state: 'closed' }]) {
    await assert.rejects(() => runGate({ env, ...apiMock({ current }) }), /未完成/)
  }
  const missing = apiMock()
  missing.fetchImpl = async () => new Response('', { status: 404 })
  await assert.rejects(() => runGate({ env, ...missing }), /404/)
})

test('fork submission reads YAML from verified fork at exact SHA', async () => {
  const mock = apiMock({ files: [{ filename: 'data/workbenches/owner__repo.yml', status: 'added' }], source: 'not: [valid' })
  await assert.rejects(() => runGate({ env, ...mock }), /YAML/)
  assert.ok(mock.calls.some((url) => url.includes(`/repos/author/fork/contents/data/workbenches/owner__repo.yml?ref=${sha}`)))
  assert.ok(!mock.calls.some((url) => url.includes('/check-runs')))
})

test('mixed submission fails for ordinary fork author', async () => {
  const mock = apiMock({ files: [{ filename: 'data/workbenches/owner__repo.yml', status: 'added' }, { filename: 'README.md', status: 'modified' }] })
  await assert.rejects(() => runGate({ env, ...mock }), /只修改一份/)
})

test('network incomplete blocks submission', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-empty-'))
  try {
    const source = await fs.readFile(path.join(ROOT, 'test/fixtures/valid/owner__repo.yml'), 'utf8')
    const mock = apiMock({ files: [{ filename: 'data/workbenches/owner__repo.yml', status: 'added' }], source, probeFailure: true })
    await assert.rejects(() => runGate({ env, ...mock, dataDir: directory }))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
