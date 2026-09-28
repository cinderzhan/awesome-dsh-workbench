import fs from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import semver from 'semver'
import { ROOT, generateCatalog, screenshotUrl, workbenchIdFor } from './catalog-lib.mjs'

export async function createPublishedValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  ajv.addSchema(JSON.parse(await fs.readFile(path.join(ROOT, 'schema/workbench.schema.json'), 'utf8')))
  return ajv.compile(JSON.parse(await fs.readFile(path.join(ROOT, 'schema/catalog.schema.json'), 'utf8')))
}

export async function validatePublishedCatalog(catalog) {
  const validate = await createPublishedValidator()
  if (!validate(catalog)) throw new Error(`发布目录协议无效：${JSON.stringify(validate.errors)}`)
  const ids = new Set()
  const workbenchIds = new Set()
  for (const item of catalog.workbenches) {
    const id = `${item.owner}/${item.repository}`.toLowerCase()
    if (item.id !== id || item.url.toLowerCase() !== `https://github.com/${id}` || ids.has(id) || item.workbenchId !== workbenchIdFor(item.owner, item.repository) || workbenchIds.has(item.workbenchId)) throw new Error('发布目录仓库或工作台身份不一致或重复')
    ids.add(id)
    workbenchIds.add(item.workbenchId)
    const install = item.distribution
    if (item.version !== install.version || semver.valid(item.version) !== item.version) throw new Error('发布目录安装版本不一致')
    if (install.type === 'github-source' && (install.commit !== item.sourceCommit || install.url !== item.url)) throw new Error('源码安装位置不一致')
    if (install.type === 'github-release' && !new URL(install.url).pathname.toLowerCase().startsWith(`/${id}/releases/download/`)) throw new Error('安装包属于其他仓库')
    for (const image of item.screenshots) {
      if (image.width * image.height > 16 * 1024 * 1024 || screenshotUrl(image.url, item.owner, item.repository) !== image.url) throw new Error('截图来源或像素范围无效')
    }
  }
  return catalog
}

export async function buildPublishedCatalog(results, categories) {
  if (results.some((result) => result.error || !result.generated)) throw new Error('探测未完成，不能生成发布目录')
  const catalog = generateCatalog(results.map(({ record }) => record), categories)
  catalog.kind = 'catalog'
  const byId = new Map(results.map((result) => [`${result.record.owner}/${result.record.repository}`.toLowerCase(), result.generated]))
  for (const item of catalog.workbenches) Object.assign(item, byId.get(item.id))
  return validatePublishedCatalog(catalog)
}
