/**
 * Minimal LSP runtime used by dsh-semantic.
 *
 * The transport/lifecycle shape is derived from dsh-lsp-diagnostics (MIT),
 * with the navigation and workspace-symbol operations this plugin needs added.
 * It deliberately keeps one process per (workspace root, language) and exposes
 * normalized, absolute-path results to the rest of the plugin.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'

const REQUEST_TIMEOUT_MS = 8_000
const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
  'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
]
const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
  'modification', 'documentation', 'defaultLibrary',
]
const DIAGNOSTICS_WAIT_MS = 2_500
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RESULTS = 20
const PHASE_PERCENT = {
  idle: 0,
  starting: 10,
  initializing: 25,
  loading: 65,
  ready: 100,
  error: 100,
}

function createStderrDecoder() {
  let gbk
  try { gbk = new TextDecoder('gb18030') } catch { gbk = new TextDecoder('utf-8') }
  return {
    decode(chunk) {
      if (typeof chunk === 'string') return chunk
      try {
        const utf8 = new TextDecoder('utf-8').decode(chunk)
        const gb = gbk.decode(chunk)
        const badUtf8 = (utf8.match(/\uFFFD/g) ?? []).length
        const badGb = (gb.match(/\uFFFD/g) ?? []).length
        // csharp-ls/.NET on Chinese Windows writes GBK when stderr is a pipe;
        // prefer the encoding with fewer replacement characters.
        return badGb < badUtf8 ? gb : utf8
      } catch {
        return String(chunk)
      }
    },
  }
}

function killProcessTree(child) {
  if (child === null || child === undefined) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
      return
    } catch { /* fall back to child.kill */ }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bundledTsserver
try {
  bundledTsserver = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js')
} catch {
  bundledTsserver = undefined
}

/** LSP servers this plugin knows how to spawn. */
export const SERVER_SPECS = {
  typescript: {
    id: 'typescript',
    displayName: 'TypeScript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    initializationOptions: bundledTsserver === undefined ? undefined : { tsserver: { path: bundledTsserver } },
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    languageIds: {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript',
      '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
    },
  },
  python: {
    id: 'python',
    displayName: 'Python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    languageIds: { '.py': 'python', '.pyi': 'python' },
  },
  csharp: {
    id: 'csharp',
    displayName: 'C#',
    command: 'csharp-ls',
    args: [],
    extensions: ['.cs'],
    languageIds: { '.cs': 'csharp' },
  },
}

const EXT_TO_SPEC = new Map()
for (const spec of Object.values(SERVER_SPECS)) {
  for (const extension of spec.extensions) EXT_TO_SPEC.set(extension, spec)
}

function normalizePath(value) {
  return resolve(value)
}

/** Windows path keys are case-insensitive; URI-derived paths may lower the drive. */
function fileKey(file) {
  const normalized = normalizePath(file)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(root, file) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep + '..'))
}

function uriToPath(uri) {
  if (typeof uri !== 'string') return undefined
  if (uri.startsWith('file:')) {
    try { return normalizePath(fileURLToPath(uri)) } catch { return undefined }
  }
  return undefined
}

function pathToUri(file) {
  return pathToFileURL(file).toString()
}

function toPosition(line, column) {
  return { line: Math.max(0, (Number(line) || 1) - 1), character: Math.max(0, (Number(column) || 1) - 1) }
}

function rangeOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const start = value.start
  const end = value.end
  if (start === null || typeof start !== 'object' || end === null || typeof end !== 'object') return undefined
  return {
    start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
    end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
  }
}

/** Normalize a Location / LocationLink / array from an LSP response. */
function normalizeLocations(result, root) {
  const input = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result]
  const out = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const uri = item.uri ?? item.targetUri
    const range = rangeOf(item.range ?? item.targetSelectionRange ?? item.targetRange)
    const file = uriToPath(uri)
    if (file === undefined || range === undefined || !isWithin(root, file)) continue
    out.push({
      file,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    })
  }
  return out
}

/** Normalize WorkspaceSymbol / SymbolInformation results. */
function normalizeWorkspaceSymbols(result, root, requested) {
  const input = Array.isArray(result) ? result : []
  const out = []
  for (const item of input) {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string') continue
    const location = item.location
    if (location === null || typeof location !== 'object') continue
    const file = uriToPath(location.uri)
    const range = rangeOf(location.range)
    if (file === undefined || range === undefined || !isWithin(root, file)) continue
    // csharp-ls returns display strings such as "bool Car.bIsTickable" or
    // "void Car.Drive()". Keep the symbol chain, not its signature.
    let symbolName = item.name.trim().replace(/\([^()]*\)\s*$/, '')
    const words = symbolName.split(/\s+/)
    if (words.length > 1) symbolName = words[words.length - 1]
    const dot = symbolName.lastIndexOf('.')
    const containerName = typeof item.containerName === 'string'
      ? item.containerName
      : dot > 0 ? symbolName.slice(0, dot) : undefined
    const name = dot > 0 ? symbolName.slice(dot + 1) : symbolName
    const qualified = containerName === undefined ? name : `${containerName}.${name}`
    const bare = requested.includes('.') ? requested.slice(requested.lastIndexOf('.') + 1) : requested
    let score = 0.72
    if (qualified === requested || name === requested) score = 1
    else if (qualified.endsWith(`.${requested}`) || qualified.endsWith(requested)) score = 0.94
    else if (name === bare && requested.includes('.')) score = 0.82
    else if (name === bare) score = 0.9
    out.push({
      name,
      qualifiedName: qualified,
      containerName,
      kind: String(item.kind ?? 'symbol'),
      file,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      score,
    })
  }
  return out
}

export class LspServer {
  constructor(root, spec) {
    this.root = normalizePath(root)
    this.spec = spec
    this.child = null
    this.connection = null
    this.startPromise = null
    this.disposed = false
    this.docs = new Map()
    this.diagnostics = new Map()
    this.diagnosticPulse = new Map()
    this.diagnosticWaiters = new Map()
    this.stderrTail = ''
    this.capabilities = null
  }

  get running() {
    return this.connection !== null && !this.disposed
  }

  async start() {
    if (this.running) return
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.startInternal().catch(error => {
      this.startPromise = null
      throw error
    })
    return this.startPromise
  }

  async startInternal() {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.root,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    const stderrDecoder = createStderrDecoder()
    child.stderr?.on('data', chunk => {
      this.stderrTail = (this.stderrTail + stderrDecoder.decode(chunk)).slice(-4096)
    })
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})

    const spawnError = new Promise((_, reject) => {
      child.once('error', error => reject(error))
    })
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    )
    this.connection = connection
    connection.onNotification('textDocument/publishDiagnostics', params => this.ingestDiagnostics(params))
    connection.onError(() => {})
    child.once('exit', () => {
      this.connection = null
      this.startPromise = null
      if (!this.disposed) this.disposed = false
    })
    connection.listen()

    const rootName = this.root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    this.initializeResult = await Promise.race([
      spawnError,
      this.withTimeout('initialize', (c) => c.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToUri(this.root),
        capabilities: {
          workspace: {
            symbol: { symbolKind: { valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] } },
            workspaceFolders: true,
          },
          textDocument: {
            publishDiagnostics: { tagSupport: { valueSet: [1, 2] } },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            synchronization: { didSave: true },
            semanticTokens: {
              requests: { full: true },
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
              formats: ['relative'],
            },
          },
        },
        workspaceFolders: [{ uri: pathToUri(this.root), name: rootName }],
        ...(this.spec.initializationOptions === undefined ? {} : { initializationOptions: this.spec.initializationOptions }),
      })),
    ])
    this.capabilities = this.initializeResult?.capabilities ?? null
    connection.sendNotification('initialized', {})
  }

  async ensureOpen(absPath, options = {}) {
    await this.start()
    const file = normalizePath(absPath)
    let text
    try {
      const info = await stat(file)
      if (info.size > MAX_FILE_BYTES) throw new Error(`file too large: ${file}`)
      text = await readFile(file, 'utf8')
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message ?? String(error)}`)
    }
    const uri = pathToUri(file)
    const languageId = this.spec.languageIds[extname(file).toLowerCase()] ?? this.spec.id
    const existing = this.docs.get(uri)
    const connection = this.connection
    if (connection === null) throw new Error(`${this.spec.displayName}: LSP connection is not ready`)
    if (existing === undefined) {
      this.docs.set(uri, { languageId, text, version: 1 })
      connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      })
      return { justOpened: true, text }
    }
    if (existing.text !== text || options.force === true) {
      existing.version += 1
      existing.text = text
      connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      })
      return { justOpened: false, text }
    }
    return { justOpened: false, text }
  }

  ingestDiagnostics(params) {
    try {
      const file = uriToPath(params.uri)
      if (file === undefined || !isWithin(this.root, file)) return
      const list = Array.isArray(params.diagnostics) ? params.diagnostics : []
      const mapped = list.map(item => {
        const range = rangeOf(item.range) ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        return {
          file,
          line: range.start.line + 1,
          column: range.start.character + 1,
          endLine: range.end.line + 1,
          endColumn: range.end.character + 1,
          severity: Number(item.severity) || 3,
          code: item.code === undefined ? undefined : String(item.code),
          source: typeof item.source === 'string' ? item.source : this.spec.displayName,
          message: typeof item.message === 'string' ? item.message : String(item.message ?? ''),
        }
      })
      this.diagnostics.set(fileKey(file), mapped)
      this.diagnosticPulse.set(fileKey(file), (this.diagnosticPulse.get(fileKey(file)) ?? 0) + 1)
      const waiters = this.diagnosticWaiters.get(fileKey(file)) ?? []
      this.diagnosticWaiters.delete(fileKey(file))
      for (const wake of waiters) wake()
    } catch {
      // Malformed diagnostics are ignored; they must not break the server.
    }
  }

  async waitForDiagnostics(file, timeoutMs = DIAGNOSTICS_WAIT_MS, baseline) {
    const key = fileKey(file)
    const pulse = this.diagnosticPulse.get(key) ?? 0
    const from = baseline === undefined ? pulse : baseline
    if (pulse > from) return
    await new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      const list = this.diagnosticWaiters.get(key) ?? []
      list.push(() => { clearTimeout(timer); resolve() })
      this.diagnosticWaiters.set(key, list)
    })
  }

  pulseFor(file) {
    return this.diagnosticPulse.get(fileKey(file)) ?? 0
  }

  diagnosticsFor(file) {
    return this.diagnostics.get(fileKey(file)) ?? []
  }

  allDiagnostics() {
    return [...this.diagnostics.values()].flat()
  }

  async request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.start()
    return this.withTimeout(method, (connection) => connection.sendRequest(method, params), timeoutMs)
  }

  async definition(file, line, column) {
    await this.ensureOpen(file)
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(normalizePath(file)) },
      position: toPosition(line, column),
    })
    return normalizeLocations(result, this.root)
  }

  async references(file, line, column) {
    await this.ensureOpen(file)
    const result = await this.request('textDocument/references', {
      textDocument: { uri: pathToUri(normalizePath(file)) },
      position: toPosition(line, column),
      context: { includeDeclaration: true },
    })
    return normalizeLocations(result, this.root)
  }

  async documentSymbols(file) {
    await this.ensureOpen(file)
    const result = await this.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(normalizePath(file)) },
    })
    const out = []
    const walk = (items) => {
      for (const item of Array.isArray(items) ? items : []) {
        if (item === null || typeof item !== 'object') continue
        const range = rangeOf(item.selectionRange ?? item.range)
        if (range !== undefined) {
          out.push({
            name: String(item.name ?? ''),
            kind: String(item.kind ?? 'symbol'),
            file: normalizePath(file),
            line: range.start.line + 1,
            column: range.start.character + 1,
          })
        }
        if (Array.isArray(item.children)) walk(item.children)
      }
    }
    walk(result)
    return out
  }

  async workspaceSymbols(query) {
    const timeoutMs = this.spec.id === 'csharp' ? 45_000 : REQUEST_TIMEOUT_MS
    const result = await this.request('workspace/symbol', { query: String(query ?? '') }, timeoutMs)
    return normalizeWorkspaceSymbols(result, this.root, String(query ?? ''))
  }

  semanticTokenLegend() {
    const provider = this.capabilities?.semanticTokensProvider
    const legend = provider?.legend
    if (legend === null || typeof legend !== 'object') return null
    return {
      tokenTypes: Array.isArray(legend.tokenTypes) ? legend.tokenTypes : [],
      tokenModifiers: Array.isArray(legend.tokenModifiers) ? legend.tokenModifiers : [],
    }
  }

  async semanticTokens(file) {
    const legend = this.semanticTokenLegend()
    if (legend === null) return { data: [], legend: null }
    await this.ensureOpen(file)
    const uri = pathToUri(normalizePath(file))
    const request = () => this.request('textDocument/semanticTokens/full', { textDocument: { uri } }, 20_000)
    let data = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await request()
      data = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
      if (data.length > 0) break
      // Roslyn/csharp-ls answers an empty token set while the solution is still
      // loading; retry before telling Monaco there is nothing to color.
      await new Promise(resolve => setTimeout(resolve, [2_500, 5_000, 8_000][attempt] ?? 8_000))
    }
    return { data, legend }
  }

  async hover(file, line, column) {
    await this.ensureOpen(file)
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(normalizePath(file)) },
      position: toPosition(line, column),
    })
  }

  async withTimeout(label, run, timeoutMs = REQUEST_TIMEOUT_MS) {
    const connection = this.connection
    if (connection === null) throw new Error(`${this.spec.displayName}: LSP connection is not ready`)
    let timer
    try {
      return await Promise.race([
        run(connection),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${this.spec.displayName}: ${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async dispose() {
    this.disposed = true
    const connection = this.connection
    this.connection = null
    this.docs.clear()
    this.diagnostics.clear()
    if (connection !== null) {
      try {
        await Promise.race([
          (async () => {
            await connection.sendRequest('shutdown')
            await connection.sendNotification('exit')
          })(),
          new Promise(resolve => setTimeout(resolve, 1000)),
        ])
      } catch {
        // Already gone.
      }
      connection.dispose()
    }
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null && !child.killed) killProcessTree(child)
  }
}

/** Find source files for a bounded workspace diagnostic scan. */
async function findCandidateFiles(root, extensions, limit) {
  const out = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 1600 && out.length < limit) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited += 1
      if (visited >= 1600) break
      const name = entry.name
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'bin', 'obj', '.vs', 'Intermediate', 'DerivedDataCache'].includes(name)) continue
        if (depth < 4) queue.push({ dir: join(dir, name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (name.startsWith('_') || name.startsWith('lib_client')) continue
      if (extensions.includes(extname(name).toLowerCase())) out.push(join(dir, name))
    }
  }
  return out
}

/** Find the most useful solution near the workspace root for csharp-ls. */
async function findSolution(root) {
  const candidates = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 700 && candidates.length < 8) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited += 1
      if (visited >= 700) break
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'bin', 'obj', '.vs', 'Intermediate', 'DerivedDataCache', 'Plugins'].includes(entry.name)) continue
        if (depth < 3) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.sln')) candidates.push(join(dir, entry.name))
    }
  }
  if (candidates.length === 0) return undefined
  // Prefer the gameplay/managed solution over plugin-internal ones.
  return candidates.find(file => /managed|gameplay/i.test(file)) ?? candidates[0]
}

/** Pick the most likely language for a workspace without scanning every file. */
async function detectServerSpec(root) {
  let entries = []
  try { entries = await readdir(root) } catch { return SERVER_SPECS.typescript }
  const lower = entries.map(name => name.toLowerCase())
  if (lower.some(name => name.endsWith('.sln') || name.endsWith('.csproj') || name.endsWith('.uproject'))) {
    const solution = await findSolution(root)
    if (solution === undefined) return SERVER_SPECS.csharp
    return {
      ...SERVER_SPECS.csharp,
      args: ['--solution', relative(root, solution).replace(/\\/g, '/')],
    }
  }
  if (lower.includes('pyproject.toml') || lower.includes('requirements.txt')) return SERVER_SPECS.python
  if (lower.includes('package.json') || lower.includes('tsconfig.json')) return SERVER_SPECS.typescript
  return SERVER_SPECS.typescript
}

/** Find one source file for project discovery; bounded so a monorepo is not scanned. */
async function findCandidateFile(root, extensions) {
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 1200) {
    const { dir, depth } = queue.shift()
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited += 1
      if (visited >= 1200) break
      const name = entry.name
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'bin', 'obj', '.vs', 'Intermediate', 'DerivedDataCache'].includes(name)) continue
        if (depth < 4) queue.push({ dir: join(dir, name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (extensions.includes(extname(name).toLowerCase())) return join(dir, name)
    }
  }
  return undefined
}

const SOURCE_INDEX_CACHE = new Map()
const SOURCE_INDEX_SKIP = new Set([
  'node_modules', '.git', '.vs', '.idea', 'bin', 'obj', 'Intermediate', 'Binaries',
  'Saved', 'Library', 'DerivedDataCache', 'Logs', '.agents', '.phicoding',
])

/**
 * csharp-ls only loads the projects in one solution. UE's generated plugin
 * sources (Plugins source trees) are compiled DLL references instead, so their type
 * definitions are absent from the LSP workspace. Index declarations across the
 * real workspace once and use it as a read-only F12 fallback for those sources.
 */
function buildSourceIndex(root) {
  const cached = SOURCE_INDEX_CACHE.get(root)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const index = new Map()
    const externalRoots = ['Plugins', 'Source', 'CI']
      .map(name => join(root, name))
      .filter(path => existsSync(path))
    const queue = (externalRoots.length > 0 ? externalRoots : [root]).map(dir => ({ dir, depth: 0 }))
    let files = 0
    while (queue.length > 0 && files < 50_000) {
      const { dir, depth } = queue.shift()
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const name = entry.name
        if (entry.isDirectory()) {
          const nextDir = join(dir, name)
          // Generated UnrealSharp C# is real source even though it lives under
          // Intermediate; the rest of Intermediate is binary/intermediate data.
          const generatedSource = name === 'Intermediate' && existsSync(join(nextDir, 'UnrealSharp'))
          if ((SOURCE_INDEX_SKIP.has(name) && !generatedSource) || depth > 12) continue
          queue.push({ dir: nextDir, depth: depth + 1 })
          continue
        }
        if (!entry.isFile() || !name.toLowerCase().endsWith('.cs')) continue
        files += 1
        if (files > 50_000) break
        const file = join(dir, name)
        let text
        try {
          const info = await stat(file)
          if (info.size > 1_500_000) continue
          text = await readFile(file, 'utf8')
        } catch { continue }
        const lines = text.split(/\r?\n/)
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex]
          if (!/(class|struct|interface|enum|record|delegate)\s/.test(line)) continue
          const pattern = /\b(class|struct|interface|enum|record(?:\s+(?:struct|class))?|delegate)\s+([A-Za-z_][A-Za-z0-9_]*)/g
          let match
          while ((match = pattern.exec(line)) !== null) {
            const key = match[2]
            const list = index.get(key) ?? []
            if (list.length >= 80) continue
            list.push({
              file,
              line: lineIndex + 1,
              column: match.index + 1,
              endLine: lineIndex + 1,
              endColumn: match.index + match[0].length + 1,
              name: key,
              kind: 'file',
              score: 1,
              text: key,
              source: 'source-index',
            })
            index.set(key, list)
          }
        }
      }
    }
    return index
  })()
  SOURCE_INDEX_CACHE.set(root, promise)
  return promise
}

function wordAtPosition(text, line, column) {
  const lines = String(text ?? '').split(/\r?\n/)
  const value = lines[Math.max(0, line - 1)] ?? ''
  let index = Math.max(0, Number(column) - 1)
  const isWord = char => /[A-Za-z0-9_]/.test(char)
  if (!isWord(value[index] ?? '')) {
    while (index > 0 && !isWord(value[index] ?? '')) index -= 1
  }
  if (!isWord(value[index] ?? '')) return ''
  let start = index
  let end = index + 1
  while (start > 0 && isWord(value[start - 1])) start -= 1
  while (end < value.length && isWord(value[end])) end += 1
  return value.slice(start, end)
}

async function sourceDefinition(root, file, line, column) {
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { return [] }
  let name = wordAtPosition(text, line, column)
  if (name === '') return []
  const index = await buildSourceIndex(root)
  let hits = index.get(name) ?? []
  if (hits.length === 0 && name.includes('.')) hits = index.get(name.slice(name.lastIndexOf('.') + 1)) ?? []
  if (hits.length === 0 && /^[AUF]/.test(name)) {
    // Native/UnrealSharp wrapper types often share the same tail after the
    // UE prefix; keep the fallback conservative and only try exact-ish tails.
    hits = index.get(name.slice(1)) ?? []
  }
  return hits.slice(0, MAX_RESULTS)
}

export class SemanticManager {
  constructor(root) {
    this.root = normalizePath(root)
    this.servers = new Map()
    this.detected = null
    this.detectedAt = 0
    this.failures = new Map()
    this.queryCache = new Map()
    this.warmed = false
    this.warmupPromise = null
    this.recovering = false
    this.recoveryCount = 0
    this.events = []
    this.progress = {
      phase: 'idle',
      message: '等待打开源文件',
      solution: null,
      since: Date.now(),
      updatedAt: Date.now(),
    }
  }

  record(message, percent) {
    const value = percent ?? PHASE_PERCENT[this.progress.phase] ?? 0
    const event = { at: Date.now(), message: String(message), percent: value }
    this.events.push(event)
    if (this.events.length > 120) this.events.shift()
    return event
  }

  setProgress(phase, message) {
    if (this.progress.phase === phase && this.progress.message === message) return
    this.progress = {
      ...this.progress,
      phase,
      message,
      since: this.progress.phase === phase ? this.progress.since : Date.now(),
      updatedAt: Date.now(),
    }
    this.record(message, PHASE_PERCENT[phase] ?? 0)
  }

  async detect() {
    if (this.detected !== null && Date.now() - this.detectedAt < 60_000) return this.detected
    this.detected = await detectServerSpec(this.root)
    this.detectedAt = Date.now()
    if (this.detected.id === 'csharp' && Array.isArray(this.detected.args) && this.detected.args.length >= 2) {
      this.progress.solution = this.detected.args[1]
    }
    return this.detected
  }

  async serverFor(spec) {
    let server = this.servers.get(spec.id)
    if (server === undefined) {
      server = new LspServer(this.root, spec)
      this.servers.set(spec.id, server)
      this.setProgress('starting', `启动 ${spec.displayName} LSP`)
    }
    const failure = this.failures.get(spec.id)
    if (failure !== undefined && Date.now() - failure.at < 30_000) throw new Error(failure.message)
    const wasRunning = server.running
    try {
      await server.start()
      this.failures.delete(spec.id)
      if (!wasRunning) {
        // A fresh LSP process has no solution/type graph yet. The previous
        // warmup promise belongs to the dead process; reset it and start a new
        // load instead of leaving progress at "initializing" forever.
        this.warmed = false
        this.warmupPromise = null
        this.setProgress('initializing', `${spec.displayName} LSP 已启动，正在初始化`)
        void this.warmup(server, spec)
      }
    } catch (error) {
      this.failures.set(spec.id, { at: Date.now(), message: String(error?.message ?? error) })
      this.setProgress('error', `LSP 启动失败：${error?.message ?? error}`)
      throw error
    }
    return server
  }

  async primaryServer() {
    const spec = await this.detect()
    return this.serverFor(spec)
  }

  /**
   * TypeScript (and some other servers) answer workspace/symbol only after a
   * project has been discovered from an opened document. Open one cheap
   * source file once so the first bare-name lookup has a project.
   */
  async warmup(server, spec) {
    if (this.warmupPromise !== null) return this.warmupPromise
    if (this.warmed) return
    this.warmed = true
    this.warmupPromise = (async () => {
      const file = await findCandidateFile(this.root, spec.extensions)
      this.setProgress('loading', spec.id === 'csharp'
        ? `加载 ${this.progress.solution ?? 'solution'} 与类型图`
        : '索引工作区符号')
      if (file === undefined) return
      try {
        await server.ensureOpen(file)
        await new Promise(resolve => setTimeout(resolve, 1_800))
        if (spec.id !== 'csharp') {
          this.setProgress('ready', `${spec.displayName} 就绪`)
          return
        }
        // csharp-ls answers workspace/symbol only after the solution finished
        // loading; use that as a real "type graph ready" signal.
        this.setProgress('loading', `解析 ${this.progress.solution ?? 'solution'}（Roslyn 类型图加载中）`)
        try {
          await server.request('workspace/symbol', { query: '__dsh_semantic_probe__' }, 90_000)
          this.setProgress('ready', `${spec.displayName} 类型图就绪`)
          // Solution projects are warm; index the plugin/generated source tree
          // in the background so F12 into DLL-referenced types can fall back.
          this.record('索引工作区外部源（插件/生成代码）')
          void buildSourceIndex(this.root).then(index => {
            this.record(`外部源索引就绪：${index.size} 个类型`)
          }).catch(error => {
            this.record(`外部源索引失败：${error?.message ?? error}`)
          })
        } catch (error) {
          this.setProgress('error', `类型图加载失败：${error?.message ?? error}`)
        }
      } catch (error) {
        this.setProgress('error', `工作区加载失败：${error?.message ?? error}`)
      }
    })()
    return this.warmupPromise
  }

  async warmupForRoot() {
    const spec = await this.detect()
    const server = await this.serverFor(spec)
    void this.warmup(server, spec)
    return this.status()
  }

  async resolveNames(names) {
    const out = []
    const seen = new Set()
    const server = await this.primaryServer()
    const spec = await this.detect()
    const warm = this.warmup(server, spec)
    if (spec.id !== 'csharp') await warm
    for (const raw of Array.isArray(names) ? names.slice(0, 24) : []) {
      const name = typeof raw === 'string' ? raw.trim() : ''
      if (name === '' || name.length > 240) continue
      const cached = this.queryCache.get(name)
      if (cached !== undefined && Date.now() - cached.at < 60_000) {
        for (const hit of cached.hits) {
          const key = `${hit.file}:${hit.line}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ ...hit, text: name })
        }
        continue
      }
      let hits = []
      try { hits = await server.workspaceSymbols(name) } catch { hits = [] }
      if (hits.length === 0 && name.includes('.')) {
        const bare = name.slice(name.lastIndexOf('.') + 1)
        try { hits = await server.workspaceSymbols(bare) } catch { hits = [] }
      }
      if (hits.length === 0) {
        try {
          const index = await buildSourceIndex(this.root)
          const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
          hits = (index.get(bare) ?? []).slice(0, MAX_RESULTS)
          if (hits.length > 0) this.record(`外部源回退：${name} -> ${hits[0].file}:${hits[0].line}`)
        } catch { /* source index is additive */ }
      }
      hits.sort((left, right) => right.score - left.score)
      this.queryCache.set(name, { at: Date.now(), hits: hits.slice(0, MAX_RESULTS) })
      for (const hit of hits.slice(0, MAX_RESULTS)) {
        const key = `${hit.file}:${hit.line}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ ...hit, text: name })
      }
    }
    return out
  }

  async specForFile(file) {
    const detected = await this.detect()
    const extension = extname(file).toLowerCase()
    if (Array.isArray(detected.extensions) && detected.extensions.includes(extension)) return detected
    return EXT_TO_SPEC.get(extension) ?? detected
  }

  async definition(file, line, column) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    let result = []
    try { result = await server.definition(file, line, column) } catch { result = [] }
    // Assembly/metadata locations are not source files; opening them makes the
    // preview hang. Treat them as "not found" and use the source fallback.
    if (Array.isArray(result)) {
      result = result.filter(item => {
        try { return typeof item?.file === 'string' && existsSync(item.file) && !/[\\/]\.nuget[\\/]/i.test(item.file) } catch { return false }
      })
    }
    if (!Array.isArray(result) || result.length === 0) {
      try {
        result = await sourceDefinition(this.root, file, line, column)
        if (result.length > 0) this.record(`外部源定义回退：${result[0].file}:${result[0].line}`)
      } catch { result = [] }
    }
    if (Array.isArray(result) && result.length > 0) this.setProgress('ready', `${spec.displayName} 类型图就绪`)
    return result
  }

  async references(file, line, column) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    return server.references(file, line, column)
  }

  async documentSymbols(file) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    return server.documentSymbols(file)
  }

  async warmupForFile(file) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    // Opening another file must not downgrade an already-ready workspace back
    // to "loading". Only a workspace that has never been warmed up starts a
    // solution load here.
    if (this.progress.phase !== 'ready') {
      this.setProgress('loading', spec.id === 'csharp'
        ? `加载 ${this.progress.solution ?? 'solution'} 与类型图`
        : '索引工作区符号')
    }
    try { await server.ensureOpen(file) } catch { /* diagnostics report the failure */ }
    if (!this.warmed && this.warmupPromise === null) void this.warmup(server, spec)
    return this.status()
  }

  async semanticTokens(file) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    const result = await server.semanticTokens(file)
    if (Array.isArray(result.data) && result.data.length > 0) {
      this.setProgress('ready', `${spec.displayName} 类型图就绪`)
    }
    return result
  }

  async diagnostics(file) {
    const spec = await this.specForFile(file)
    const server = await this.serverFor(spec)
    await server.ensureOpen(file)
    const baseline = server.pulseFor(file)
    await server.waitForDiagnostics(file, 2_500, baseline)
    if (server.diagnosticsFor(file).length === 0) {
      // Some servers only publish after a document revision; a forced didChange
      // makes the first open deterministic without touching the file on disk.
      const beforeForce = server.pulseFor(file)
      await server.ensureOpen(file, { force: true })
      await server.waitForDiagnostics(file, 4_000, beforeForce)
    }
    return server.diagnosticsFor(file)
  }

  async workspaceDiagnostics() {
    const spec = await this.detect()
    const server = await this.serverFor(spec)
    const files = await findCandidateFiles(this.root, spec.extensions, 8)
    for (const file of files) {
      try {
        const baseline = server.pulseFor(file)
        await server.ensureOpen(file)
        await server.waitForDiagnostics(file, 900, baseline)
      } catch {
        // One unreadable file must not hide the rest of the list.
      }
    }
    return server.allDiagnostics()
  }

  async recover(spec) {
    this.record('自动重启 LSP 进程')
    await this.reset()
    this.setProgress('starting', `${spec.displayName} LSP 自动重启中`)
    const fresh = await this.detect()
    // serverFor starts the fresh process and schedules a new warmup.
    await this.serverFor(fresh)
    this.recovering = false
  }

  async status() {
    const spec = await this.detect()
    const server = this.servers.get(spec.id)
    const elapsed = Date.now() - this.progress.since
    if (this.progress.phase === 'initializing' && elapsed > 8_000) {
      this.setProgress('loading', spec.id === 'csharp'
        ? `正在加载 ${this.progress.solution ?? 'solution'} 与类型图`
        : '正在索引工作区')
    } else if (this.progress.phase === 'loading' && elapsed > 90_000 && !this.recovering && this.recoveryCount < 2) {
      this.recovering = true
      this.recoveryCount += 1
      this.record(`LSP 加载超时，自动重启（第 ${this.recoveryCount} 次）`)
      void this.recover(spec).catch(error => {
        this.recovering = false
        this.setProgress('error', `自动重启失败：${error?.message ?? error}`)
      })
    } else if (this.progress.phase === 'loading' && elapsed > 300_000) {
      this.setProgress('error', `加载超时（已等待 ${Math.round(elapsed / 1000)} 秒），请点击重试或刷新`)
    }
    const waitedMs = this.progress.phase === 'initializing' || this.progress.phase === 'loading'
      ? Math.max(0, Date.now() - this.progress.since)
      : 0
    return {
      root: this.root,
      language: spec.id,
      displayName: spec.displayName,
      command: spec.command,
      solution: this.progress.solution,
      phase: this.progress.phase,
      message: this.progress.message,
      since: this.progress.since,
      waitedMs,
      events: this.events.slice(-40),
      running: server?.running === true,
      stderr: server?.stderrTail ?? '',
      error: this.failures.get(spec.id)?.message ?? null,
    }
  }

  async reset() {
    await this.dispose()
    this.servers.clear()
    this.failures.clear()
    this.queryCache.clear()
    this.warmed = false
    this.warmupPromise = null
    this.events = []
    this.progress = {
      phase: 'idle',
      message: '等待重新加载',
      solution: null,
      since: Date.now(),
      updatedAt: Date.now(),
    }
    return this.status()
  }

  async dispose() {
    await Promise.allSettled([...this.servers.values()].map(server => server.dispose()))
    this.servers.clear()
  }
}

export const __test = { normalizeLocations, normalizeWorkspaceSymbols, detectServerSpec, SERVER_SPECS }

export { buildSourceIndex, sourceDefinition }
