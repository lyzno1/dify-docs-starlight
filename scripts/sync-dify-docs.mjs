#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DOCS_ROOT = path.join(ROOT, 'src', 'content', 'docs')
const UPSTREAM_ROOT = path.join(ROOT, 'upstream')
const UPSTREAM_REPO = 'https://github.com/langgenius/dify-docs.git'

const args = process.argv.slice(2)
const localFlag = args.find(a => a.startsWith('--local='))
const branchFlag = args.find(a => a.startsWith('--branch='))
const localPath = localFlag ? localFlag.slice('--local='.length) : undefined
const branch = branchFlag ? branchFlag.slice('--branch='.length) : 'main'

const PUBLIC_ROOT = path.join(ROOT, 'public')
const SYNCED_SECTIONS = ['use-dify', 'self-host', 'develop-plugin', 'api-reference']
const SYNCED_STATIC_DIRS = ['images', 'logo']

const LOCALE_MAP = {
  en: '',
  zh: 'zh-cn',
  ja: 'ja',
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  })
  if (result.status !== 0) {
    const msg = [
      `Command failed: ${command} ${commandArgs.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(msg)
  }
  return result.stdout?.trim() ?? ''
}

// --- Frontmatter parsing ---

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match)
    return { attrs: {}, body: content, raw: '' }

  const raw = match[1]
  const body = content.slice(match[0].length)
  const attrs = {}

  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) {
      let val = kv[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1)
      }
      attrs[kv[1]] = val
    }
  }

  return { attrs, body, raw }
}

function buildFrontmatter(attrs) {
  const lines = ['---']
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null)
      continue
    if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value)) {
        lines.push(`  ${k}: ${typeof v === 'string' && v.includes(':') ? `"${v}"` : v}`)
      }
    }
    else if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('\'') || value === '')) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`)
    }
    else {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

// --- docs.json order extraction ---

function extractPageOrder(docsJsonPath) {
  const docsJson = JSON.parse(readFileSync(docsJsonPath, 'utf8'))
  const orderMap = new Map()
  const latestVersion = docsJson.navigation?.versions?.find(v => v.version === 'Latest')
  if (!latestVersion)
    return orderMap

  const enLang = latestVersion.languages?.find(l => l.language === 'en')
  if (!enLang)
    return orderMap

  let globalOrder = 0

  function walkPages(pages) {
    for (const item of pages) {
      if (typeof item === 'string') {
        const normalized = item.replace(/^en\//, '')
        orderMap.set(normalized, ++globalOrder)
      }
      else if (item && typeof item === 'object') {
        if (item.pages) {
          walkPages(item.pages)
        }
      }
    }
  }

  for (const dropdown of enLang.dropdowns ?? []) {
    walkPages(dropdown.pages ?? [])
  }

  return orderMap
}

// --- MDX file operations ---

async function listMdxFiles(directory) {
  const files = []
  if (!existsSync(directory))
    return files

  async function walk(currentDir, prefix) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.'))
        continue
      const absolute = path.join(currentDir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await walk(absolute, relative)
      }
      else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        files.push(relative)
      }
    }
  }

  await walk(directory, '')
  files.sort()
  return files
}

function isTrackedPath(relPath) {
  return SYNCED_SECTIONS.some(s => relPath.startsWith(`${s}/`) || relPath === s)
}

const MINTLIFY_COMPONENTS = [
  'Card',
  'CardGroup',
  'Note',
  'Info',
  'Warning',
  'Tip',
  'Danger',
  'Callout',
  'Tabs',
  'Tab',
  'Steps',
  'Step',
  'Accordion',
  'AccordionGroup',
  'Frame',
  'ResponseField',
  'Expandable',
  'Icon',
  'ParamField',
  'CodeGroup',
  'Check',
  'CheckList',
  'CheckListItem',
]

function detectUsedComponents(body) {
  const used = []
  for (const name of MINTLIFY_COMPONENTS) {
    const pattern = new RegExp(`<${name}[\\s/>]`, 'm')
    if (pattern.test(body)) {
      used.push(name)
    }
  }
  return used
}

function buildComponentImports(components) {
  if (components.length === 0)
    return ''
  return `${components
    .map(name => `import ${name} from '@/components/mintlify/${name}.astro';`)
    .join('\n')}\n\n`
}

function normalizeCodeFences(text) {
  return text.replace(/^(\s*```\s*)([\w+-]+)/gm, (_match, fence, lang) => `${fence}${lang.toLowerCase()}`)
}

function transformContent(content, sidebarOrder) {
  const { attrs, body } = parseFrontmatter(content)

  const newAttrs = {}
  if (attrs.title)
    newAttrs.title = attrs.title
  if (attrs.description)
    newAttrs.description = attrs.description

  const sidebar = {}
  if (attrs.sidebarTitle)
    sidebar.label = attrs.sidebarTitle
  if (sidebarOrder !== undefined)
    sidebar.order = sidebarOrder

  if (Object.keys(sidebar).length > 0) {
    newAttrs.sidebar = sidebar
  }

  const usedComponents = detectUsedComponents(body)
  const imports = buildComponentImports(usedComponents)

  const normalizedBody = normalizeCodeFences(body.startsWith('\n') ? body.slice(1) : body)
  return `${buildFrontmatter(newAttrs)}\n${imports}${normalizedBody}`
}

async function listAllFiles(directory) {
  const files = []
  if (!existsSync(directory))
    return files

  async function walk(currentDir, prefix) {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.'))
        continue
      const absolute = path.join(currentDir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(absolute, relative)
      }
      else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }

  await walk(directory, '')
  return files
}

async function syncStaticAssets(repoRoot) {
  let totalCopied = 0

  for (const dir of SYNCED_STATIC_DIRS) {
    const sourceDir = path.join(repoRoot, dir)
    const destDir = path.join(PUBLIC_ROOT, dir)

    if (!existsSync(sourceDir)) {
      console.log(`  Static dir not found: ${dir}, skipping`)
      continue
    }

    await rm(destDir, { recursive: true, force: true })
    const files = await listAllFiles(sourceDir)

    for (const relPath of files) {
      const src = path.join(sourceDir, relPath)
      const dest = path.join(destDir, relPath)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(src, dest)
    }

    totalCopied += files.length
    console.log(`  Synced ${files.length} files from ${dir}/`)
  }

  const rootAssets = ['favicon.svg', 'style.css', 'dify-logo.png']
  for (const file of rootAssets) {
    const src = path.join(repoRoot, file)
    if (existsSync(src)) {
      await copyFile(src, path.join(PUBLIC_ROOT, file))
      totalCopied++
    }
  }

  return totalCopied
}

async function ensureCleanSyncPaths() {
  for (const section of SYNCED_SECTIONS) {
    await rm(path.join(DOCS_ROOT, section), { recursive: true, force: true })
  }
  for (const localeDir of Object.values(LOCALE_MAP)) {
    if (!localeDir)
      continue
    for (const section of SYNCED_SECTIONS) {
      await rm(path.join(DOCS_ROOT, localeDir, section), { recursive: true, force: true })
    }
  }
}

async function syncLocale(repoRoot, upstreamDir, destSubdir, orderMap) {
  const sourceDir = path.join(repoRoot, upstreamDir)
  if (!existsSync(sourceDir)) {
    console.log(`  Source dir not found: ${upstreamDir}/, skipping`)
    return 0
  }

  const destRoot = destSubdir ? path.join(DOCS_ROOT, destSubdir) : DOCS_ROOT
  const allFiles = await listMdxFiles(sourceDir)
  const trackedFiles = allFiles.filter(f => isTrackedPath(f))

  for (const relPath of trackedFiles) {
    const source = path.join(sourceDir, relPath)
    const destination = path.join(destRoot, relPath)
    await mkdir(path.dirname(destination), { recursive: true })

    const raw = await readFile(source, 'utf8')
    const orderKey = relPath.replace(/\.mdx?$/, '')
    const order = orderMap.get(orderKey)
    const transformed = transformContent(raw, order)
    await writeFile(destination, transformed, 'utf8')
  }

  return trackedFiles.length
}

// --- Main ---

async function main() {
  let repoRoot
  let sourceCommit = 'local'
  let sourceRef = 'local'
  let tmpRoot

  if (localPath) {
    repoRoot = path.resolve(localPath)
    console.log(`Syncing from local path: ${localPath}`)
    try {
      sourceCommit = run('git', ['-C', localPath, 'rev-parse', 'HEAD'])
      sourceRef = run('git', ['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    }
    catch {
      // not a git repo
    }
  }
  else {
    const tmpDir = path.join(os.tmpdir(), `dify-docs-sync-${Date.now()}`)
    console.log(`Cloning dify-docs (branch: ${branch})...`)
    run(
      'git',
      ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branch, UPSTREAM_REPO, tmpDir],
      { stdio: 'inherit' },
    )
    run('git', ['-C', tmpDir, 'sparse-checkout', 'set', '--skip-checks', 'en', 'zh', 'ja', 'docs.json', 'images', 'logo', 'favicon.svg', 'style.css', 'dify-logo.png'], { stdio: 'inherit' })
    sourceCommit = run('git', ['-C', tmpDir, 'rev-parse', 'HEAD'])
    sourceRef = branch
    repoRoot = tmpDir
    tmpRoot = tmpDir
  }

  const docsJsonPath = path.join(repoRoot, 'docs.json')
  let orderMap = new Map()
  if (existsSync(docsJsonPath)) {
    console.log('Extracting page order from docs.json...')
    orderMap = extractPageOrder(docsJsonPath)
    console.log(`  Found order for ${orderMap.size} pages`)
  }

  await ensureCleanSyncPaths()

  let totalFiles = 0
  for (const [upstreamLang, destSubdir] of Object.entries(LOCALE_MAP)) {
    console.log(`Syncing ${upstreamLang}/ → ${destSubdir || '(root)'}...`)
    const count = await syncLocale(repoRoot, upstreamLang, destSubdir, orderMap)
    console.log(`  ${count} MDX files`)
    totalFiles += count
  }

  // --- Sync static assets ---
  console.log('Syncing static assets...')
  const staticCount = await syncStaticAssets(repoRoot)
  console.log(`  Total static files: ${staticCount}`)

  const manifest = {
    syncedAt: new Date().toISOString(),
    ref: sourceRef,
    locales: Object.keys(LOCALE_MAP),
    totalFiles,
  }

  const lock = {
    upstreamRepo: localPath ?? UPSTREAM_REPO,
    ref: sourceRef,
    commit: sourceCommit,
    syncedAt: new Date().toISOString(),
    counts: { totalFiles },
  }

  await mkdir(UPSTREAM_ROOT, { recursive: true })
  await writeFile(path.join(UPSTREAM_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(path.join(UPSTREAM_ROOT, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  console.log('Sync complete')
  console.log(`  Ref: ${sourceRef}`)
  console.log(`  Commit: ${sourceCommit}`)
  console.log(`  Total files: ${totalFiles}`)

  if (tmpRoot && !localPath) {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
