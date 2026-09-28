import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import yaml from 'js-yaml'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data/workbenches')

export function workbenchIdFor(owner, repository) {
  const id = `wb-${owner}-${repository}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(id)) throw new Error(`仓库身份不能生成有效的工作台 ID：${owner}/${repository}`)
  return id
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
}

export async function createValidator() {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, 'schema/workbench.schema.json'), 'utf8'))
  const categories = JSON.parse(await fs.readFile(path.join(ROOT, 'data/categories.json'), 'utf8'))
  const categoryIds = categories.map(({ id }) => id)
  const schemaIds = schema.properties.category.enum
  if (JSON.stringify(categoryIds) !== JSON.stringify(schemaIds)) {
    throw new Error('data/categories.json 与 schema 中的 category 枚举不一致')
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  return ajv.compile(schema)
}

export function repositoryParts(url) {
  const parsed = new URL(url)
  const [owner, repository, extra] = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').split('/')
  if (extra || !owner || !repository) throw new Error(`仓库地址格式无效：${url}`)
  return { owner, repository }
}

export function safeRelativePath(value, { allowDotPrefix = false } = {}) {
  if (allowDotPrefix && typeof value === 'string') value = value.replace(/^\.\//, '')
  return typeof value === 'string' && value.length <= 500 && !/[\\:%?#\x00-\x1f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..')
}

export function screenshotUrl(value, owner, repository) {
  let url
  try { url = new URL(value) } catch { throw new Error('截图必须是源仓库托管的完整 HTTPS 图片地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.href !== value) throw new Error('截图地址不能包含凭据、查询参数或不规范路径')
  const parts = url.pathname.slice(1).split('/')
  if (parts[0]?.toLowerCase() !== owner.toLowerCase() || parts[1]?.toLowerCase() !== repository.toLowerCase()) throw new Error('截图必须属于条目指向的源仓库')
  if (url.hostname === 'github.com' && parts[2] === 'blob') parts.splice(2, 1)
  else if (url.hostname !== 'raw.githubusercontent.com') throw new Error('截图必须使用 GitHub 文件地址或 raw 图片直链')
  if (parts.length < 4 || parts.some((part) => !part || /[\\/\x00-\x1f]/.test(decodeURIComponent(part)) || ['.', '..'].includes(decodeURIComponent(part))) || !/\.(png|jpe?g|webp)$/i.test(parts.at(-1))) throw new Error('截图必须是安全的 PNG/JPEG/WebP 文件地址')
  return `https://raw.githubusercontent.com/${parts.join('/')}`
}

export async function readEntry(file, validate, { example = false } = {}) {
  const relative = path.relative(ROOT, file)
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relative} 必须是普通文件`)
  let entry
  try {
    const source = await fs.readFile(file, 'utf8')
    if (Buffer.byteLength(source) > 32 * 1024) throw new Error('文件不能超过 32 KB')
    entry = yaml.load(source, { json: false, schema: yaml.JSON_SCHEMA, maxAliasCount: 20 })
  } catch (error) {
    throw new Error(`${relative} 不是有效 YAML：${error.message}`)
  }
  if (!validate(entry)) throw new Error(`${relative} 不符合 schema：${formatAjvErrors(validate.errors)}`)

  const { owner, repository } = repositoryParts(entry.url)
  if (entry.workbenchId !== undefined && entry.workbenchId !== workbenchIdFor(owner, repository)) throw new Error(`${relative} 的 workbenchId 必须为 wb-<owner>-<repo>`)
  if (repository.toLowerCase().endsWith('.git')) throw new Error(`${relative} 的 url 请使用仓库主页，不要以 .git 结尾`)
  const expected = `${owner}__${repository}.yml`.toLowerCase()
  if (!example && path.basename(file).toLowerCase() !== expected) {
    throw new Error(`${relative} 文件名应为 ${owner}__${repository}.yml`)
  }
  const images = entry.screenshots.map((image) => screenshotUrl(image, owner, repository))
  if (new Set(images).size !== images.length) throw new Error(`${relative} 的截图地址重复`)
  if (entry.tarball) {
    const asset = new URL(entry.tarball)
    if (asset.href !== entry.tarball || asset.username || asset.password || asset.search || asset.hash || !asset.pathname.toLowerCase().startsWith(`/${owner}/${repository}/releases/`.toLowerCase())) {
      throw new Error(`${relative} 的 tarball 必须指向同仓库的 GitHub Release 资源`)
    }
  }
  return { entry, owner, repository }
}

export async function loadEntries({ directory = DATA_DIR } = {}) {
  const validate = await createValidator()
  const names = (await fs.readdir(directory)).filter((name) => !name.startsWith('.')).sort()
  const invalid = names.filter((name) => !/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\.yml$/.test(name))
  if (invalid.length) throw new Error(`data/workbenches 只允许 owner__repo.yml：${invalid.join(', ')}`)
  const records = []
  for (const name of names) records.push(await readEntry(path.join(directory, name), validate))
  const ids = new Set()
  const workbenchIds = new Set()
  for (const { owner, repository, entry } of records) {
    const id = `${owner}/${repository}`.toLowerCase()
    if (ids.has(id)) throw new Error(`仓库重复：${id}`)
    const workbenchId = workbenchIdFor(owner, repository)
    if (workbenchIds.has(workbenchId)) throw new Error(`工作台 ID 重复：${workbenchId}`)
    ids.add(id)
    workbenchIds.add(workbenchId)
  }
  return records
}

export function generateCatalog(records, categories) {
  return {
    schemaVersion: 2,
    kind: 'preview',
    categories,
    workbenches: records
      .map(({ entry, owner, repository }) => ({
        id: `${owner}/${repository}`.toLowerCase(),
        workbenchId: workbenchIdFor(owner, repository),
        ...(entry.legacyWorkbenchIds ? { legacyWorkbenchIds: entry.legacyWorkbenchIds } : {}),
        owner,
        repository,
        url: entry.url.replace(/\/$/, ''),
        name: entry.name,
        description: entry.description,
        screenshots: entry.screenshots,
        category: entry.category
      }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
  }
}
