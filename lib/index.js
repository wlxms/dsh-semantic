/**
 * dsh-semantic — Host half.
 *
 * Owns LSP-backed semantic lookups (workspace symbols, definition, references,
 * document symbols) and diagnostics. Exposes both an HTTP surface for browser
 * halves and a Cordis service (`ctx.semantic`) for other Host plugins.
 */
import { isAbsolute, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { SemanticManager } from './lsp.js'
import { disposeTerminals, listShells, listTerminals, readTerminal, startTerminal, stopTerminal, writeTerminal } from './terminals.js'

export const name = 'dsh-semantic'
export const VERSION = '0.1.0'
export const inject = ['webServer', 'sessions']

const ROUTE_PREFIX = '/semantic'
const MAX_BODY_BYTES = 256 * 1024
const MAX_NAMES = 32
const managers = new Map()

function managerFor(root) {
  // Sessions and HTTP callers use both `D:\\...` and `D:/...`; a raw string
  // key would start a second csharp-ls for the same solution and let two
  // Roslyn processes contend while loading. Key by the resolved Windows path.
  const resolved = resolve(String(root))
  const key = /^[A-Za-z]:\\/.test(resolved) ? resolved.replace(/\\/g, '/').toLowerCase() : resolved.replace(/\\/g, '/')
  let manager = managers.get(key)
  if (manager === undefined) {
    manager = new SemanticManager(resolved)
    managers.set(key, manager)
  }
  return manager
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function sameOrigin(req) {
  const host = req.headers.host
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  if (!isLoopback(hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).hostname !== hostname) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
  return parsed
}

function sessionCwd(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const session = ctx.get('sessions')?.get?.(sessionId)
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function validateFile(root, file) {
  if (typeof file !== 'string' || file === '') return undefined
  const resolved = isAbsolute(file) ? file : `${root}/${file}`.replace(/[\\/]+/g, '/')
  if (!isAbsolute(resolved)) return undefined
  return resolved
}

function serviceFor(ctx) {
  return {
    async status({ root, sessionId }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'workspace unavailable' }
      try {
        return { ok: true, ...await managerFor(cwd).status() }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    async resolve({ root, sessionId, names }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      if (typeof cwd !== 'string' || cwd === '') return []
      try {
        return await managerFor(cwd).resolveNames(names)
      } catch {
        return []
      }
    },
    async definition({ root, sessionId, file, line, column }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      const target = cwd === undefined ? undefined : validateFile(cwd, file)
      if (cwd === undefined || target === undefined) return []
      try {
        return await managerFor(cwd).definition(target, line, column)
      } catch {
        return []
      }
    },
    async references({ root, sessionId, file, line, column }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      const target = cwd === undefined ? undefined : validateFile(cwd, file)
      if (cwd === undefined || target === undefined) return []
      try {
        return await managerFor(cwd).references(target, line, column)
      } catch {
        return []
      }
    },
    async documentSymbols({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      const target = cwd === undefined ? undefined : validateFile(cwd, file)
      if (cwd === undefined || target === undefined) return []
      try {
        return await managerFor(cwd).documentSymbols(target)
      } catch {
        return []
      }
    },
    async reset({ root, sessionId }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'workspace unavailable' }
      try {
        return { ok: true, ...await managerFor(cwd).reset() }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    async semanticTokens({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      const target = cwd === undefined ? undefined : validateFile(cwd, file)
      if (cwd === undefined || target === undefined) return { data: [], legend: null }
      try {
        return await managerFor(cwd).semanticTokens(target)
      } catch {
        return { data: [], legend: null }
      }
    },
    async warmup({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, error: 'workspace unavailable' }
      try {
        if (typeof file === 'string' && file !== '') {
          const target = validateFile(cwd, file)
          if (target === undefined) return { ok: false, error: 'file unavailable' }
          return { ok: true, ...await managerFor(cwd).warmupForFile(target) }
        }
        return { ok: true, ...await managerFor(cwd).warmupForRoot() }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    async read({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      // Monaco passes the absolute document path. When the session is stored
      // but not live in this Host generation, sessions.get() has no header yet;
      // an absolute path is still enough to read a sidebar document.
      const target = cwd !== undefined && cwd !== ''
        ? validateFile(cwd, file)
        : isAbsolute(file) ? file : undefined
      if (target === undefined) return { ok: false, error: 'file unavailable' }
      try {
        const info = await stat(target)
        if (!info.isFile()) return { ok: false, error: 'not a file' }
        if (info.size > 4 * 1024 * 1024) return { ok: false, error: 'file too large' }
        const buffer = await readFile(target)
        return {
          ok: true,
          value: {
            data: buffer.toString('base64'),
            text: buffer.toString('utf8'),
            absolutePath: target,
            bytes: info.size,
            version: `${info.mtimeMs}:${info.size}`,
          },
        }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    async stat({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      const target = cwd !== undefined && cwd !== ''
        ? validateFile(cwd, file)
        : isAbsolute(file) ? file : undefined
      if (target === undefined) return { ok: false, error: 'file unavailable' }
      try {
        const info = await stat(target)
        return {
          ok: true,
          value: {
            absolutePath: target,
            version: `${info.mtimeMs}:${info.size}`,
            ...(info.isFile() ? { bytes: info.size } : {}),
          },
        }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    async diagnostics({ root, sessionId, file }) {
      const cwd = root ?? sessionCwd(ctx, sessionId)
      if (cwd === undefined) return []
      try {
        if (typeof file !== 'string' || file === '') return await managerFor(cwd).workspaceDiagnostics()
        const target = validateFile(cwd, file)
        if (target === undefined) return []
        return await managerFor(cwd).diagnostics(target)
      } catch {
        return []
      }
    },
  }
}

export function apply(ctx) {
  const service = serviceFor(ctx)
  ctx.provide('semantic', service)

  ctx.effect(() => () => {
    for (const manager of managers.values()) void manager.dispose()
    managers.clear()
    disposeTerminals()
  }, 'dsh-semantic: dispose LSP servers')

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      const url = new URL(req.url, 'http://localhost')
      try {
        writeJson(res, 200, await service.status({
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          root: url.searchParams.get('root') ?? undefined,
        }))
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/resolve`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const names = Array.isArray(body.names)
          ? body.names.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 240).slice(0, MAX_NAMES)
          : []
        const results = await service.resolve({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          names,
        })
        writeJson(res, 200, { ok: true, results })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/diagnostics`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = req.method === 'POST' ? await readBody(req) : {}
        const url = new URL(req.url, 'http://localhost')
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : url.searchParams.get('sessionId') ?? undefined
        const file = typeof body.file === 'string' ? body.file : url.searchParams.get('file') ?? undefined
        const results = await service.diagnostics({
          sessionId,
          file,
        })
        writeJson(res, 200, { ok: true, results })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/definition`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const results = await service.definition({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          file: body.file,
          line: body.line,
          column: body.column,
        })
        writeJson(res, 200, { ok: true, results })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/references`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const results = await service.references({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          file: body.file,
          line: body.line,
          column: body.column,
        })
        writeJson(res, 200, { ok: true, results })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/stat`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const result = await service.stat({
          root: typeof body.root === 'string' ? body.root : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          file: body.file,
        })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/warmup`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const result = await service.warmup({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          root: typeof body.root === 'string' ? body.root : undefined,
          file: body.file,
        })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/reset`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const result = await service.reset({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          root: typeof body.root === 'string' ? body.root : undefined,
        })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminals`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      const url = new URL(req.url, 'http://localhost')
      const root = url.searchParams.get('root') ?? sessionCwd(ctx, url.searchParams.get('sessionId') ?? undefined)
      if (typeof root !== 'string' || root === '') return writeJson(res, 200, { ok: true, terminals: [] })
      writeJson(res, 200, { ok: true, terminals: listTerminals(root) })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminal/shells`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      writeJson(res, 200, { ok: true, shells: listShells() })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminal/start`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const root = body.root ?? sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : undefined)
        if (typeof root !== 'string' || root === '') return writeJson(res, 400, { ok: false, error: 'workspace unavailable' })
        const command = typeof body.command === 'string' ? body.command.slice(0, 4000) : ''
        const terminal = startTerminal({
          root,
          command,
          shellId: typeof body.shellId === 'string' ? body.shellId : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
        })
        writeJson(res, 200, { ok: true, terminal })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminal/output`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const root = body.root ?? sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : undefined)
        const terminal = typeof root === 'string' ? readTerminal(root, body.id) : null
        if (terminal === null) return writeJson(res, 404, { ok: false, error: 'terminal not found' })
        writeJson(res, 200, { ok: true, terminal })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminal/input`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const root = body.root ?? sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : undefined)
        const terminal = typeof root === 'string' ? writeTerminal(root, body.id, body.text) : null
        writeJson(res, 200, terminal === null ? { ok: false, error: 'terminal not found' } : { ok: true, terminal })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/terminal/stop`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const root = body.root ?? sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : undefined)
        const terminal = typeof root === 'string' ? stopTerminal(root, body.id) : null
        writeJson(res, 200, terminal === null ? { ok: false, error: 'terminal not found' } : { ok: true, terminal })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/tokens`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const result = await service.semanticTokens({
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          file: body.file,
        })
        writeJson(res, 200, { ok: true, ...result })
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/file`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      try {
        const body = await readBody(req)
        const result = await service.read({
          root: typeof body.root === 'string' ? body.root : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          file: body.file,
        })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}
