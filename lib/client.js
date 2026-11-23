/**
 * dsh-semantic — browser half.
 *
 * When dsh-monaco is installed, paints LSP diagnostics as Monaco model markers.
 * Without Monaco the native sidebar preview has no decoration API, so this
 * half stays inert and the Host still exposes the diagnostics HTTP surface for
 * a panel/newer viewer to consume later.
 */
window.__ModuleLoader__.load({
  id: 'dsh-semantic',
  factory(require) {
    'use strict'
    const React = require('react')
    const { useEffect, useState } = React

    const API = '/semantic'
    const MARKER_OWNER = 'dsh-semantic'
    const inflight = new Map()

    function normalizePath(value) {
      return String(value).replace(/\\/g, '/')
    }

    function severityOf(monaco, severity) {
      const value = Number(severity) || 3
      if (value === 1) return monaco.MarkerSeverity.Error
      if (value === 2) return monaco.MarkerSeverity.Warning
      if (value === 4) return monaco.MarkerSeverity.Hint
      return monaco.MarkerSeverity.Info
    }

    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
        if (snapshot === undefined || snapshot === null) return ''
        const current = snapshot.current
        if (typeof current === 'string' && current !== '') return current
        const last = Array.isArray(snapshot.ids) ? snapshot.ids[snapshot.ids.length - 1] : undefined
        return typeof last === 'string' ? last : ''
      } catch {
        return ''
      }
    }

    function activeSessionId(ctx) {
      return currentSessionId(ctx)
    }

    function diagnosticsAddress(sessionId, file) {
      const encoded = String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
      return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`
    }

    function severityLabel(value) {
      if (Number(value) === 1) return { text: 'error', color: 'var(--dsw-alias-label-danger, #d9534f)' }
      if (Number(value) === 2) return { text: 'warning', color: 'var(--dsw-alias-label-warning, #d9a441)' }
      if (Number(value) === 4) return { text: 'hint', color: 'var(--dsw-alias-label-tertiary, #888)' }
      return { text: 'info', color: 'var(--dsw-alias-label-secondary, #aaa)' }
    }

    function createDiagnosticsPanel(ctx) {
      return function DiagnosticsPanel() {
        const [items, setItems] = useState([])
        const [state, setState] = useState('loading')
        useEffect(() => {
          let alive = true
          const load = async () => {
            const sessionId = activeSessionId(ctx)
            if (sessionId === '') {
              if (alive) { setItems([]); setState('no-session') }
              return
            }
            try {
              const response = await fetch(`${API}/diagnostics`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              })
              const data = await response.json()
              if (!alive) return
              setItems(Array.isArray(data?.results) ? data.results : [])
              setState('ready')
            } catch {
              if (alive) setState('error')
            }
          }
          void load()
          const timer = setInterval(() => { void load() }, 10_000)
          return () => { alive = false; clearInterval(timer) }
        }, [])
        const open = (item) => {
          const sessionId = activeSessionId(ctx)
          if (sessionId === '' || typeof item.file !== 'string') return
          try {
            ctx.get('sidebarRight').openResource(diagnosticsAddress(sessionId, item.file), { params: { line: item.line } })
          } catch { /* no mounted surface */ }
        }
        const rows = items.filter(item => Number(item.severity) === 1 || Number(item.severity) === 2).slice(0, 200).map((item, index) => {
          const severity = severityLabel(item.severity)
          return React.createElement('button', {
            key: `${item.file}:${item.line}:${index}`,
            type: 'button',
            title: `${item.file}:${item.line}:${item.column}`,
            onClick: () => open(item),
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
              border: 'none', borderBottom: '.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))',
              background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer',
              font: 'inherit', lineHeight: '1.45',
            },
          },
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
            React.createElement('span', { style: { color: severity.color, fontSize: 11, textTransform: 'uppercase' } }, severity.text),
            React.createElement('span', { style: { fontSize: 11, opacity: .65 } }, `${item.file.split(/[\\/]/).pop()}:${item.line}`)),
          React.createElement('div', { style: { fontSize: 12, marginTop: 2 } }, item.message))
        })
        return React.createElement('div', { style: { padding: '8px 0', overflow: 'auto', height: '100%' } },
          state === 'loading' ? React.createElement('div', { style: { padding: 12, opacity: .7 } }, '正在建立 LSP 诊断…') : null,
          state === 'no-session' ? React.createElement('div', { style: { padding: 12, opacity: .7 } }, '没有活动会话') : null,
          state === 'error' ? React.createElement('div', { style: { padding: 12, opacity: .7 } }, '诊断服务暂不可用') : null,
          state === 'ready' && items.length === 0 ? React.createElement('div', { style: { padding: 12, opacity: .7 } }, '当前没有错误或警告') : null,
          ...rows)
      }
    }

    async function fetchDiagnostics(sessionId, file) {
      const key = `${sessionId}\u0000${file}`
      if (inflight.has(key)) return inflight.get(key)
      const task = fetch(`${API}/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, file }),
      })
        .then(async response => {
          if (!response.ok) return []
          const data = await response.json()
          return Array.isArray(data?.results) ? data.results : []
        })
        .catch(() => [])
        .finally(() => { inflight.delete(key) })
      inflight.set(key, task)
      return task
    }

    const MONACO_TOKEN_TYPES = [
      'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
      'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
      'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
    ]
    const MONACO_TOKEN_MODIFIERS = [
      'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
      'modification', 'documentation', 'defaultLibrary',
    ]

    function modelFilePath(monaco, model) {
      try {
        if (typeof model?.uri?.fsPath === 'string' && model.uri.fsPath !== '') return model.uri.fsPath
      } catch { /* fall through */ }
      try {
        const path = decodeURIComponent(model.uri.path ?? '')
        return /^[A-Za-z]:/.test(path) ? path : path.replace(/^\//, '')
      } catch {
        return ''
      }
    }

    async function postSemantic(route, body) {
      const response = await fetch(`${API}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) return null
      return await response.json()
    }

    function installLanguageFeatures(ctx, service) {
      return (async () => {
        try {
          await service.ready
          const monaco = service.monaco
          if (monaco?.languages === undefined) return () => {}
          if (window.__dshSemanticLanguageFeatures === true) return () => {}
          window.__dshSemanticLanguageFeatures = true
          const featureDebug = window.__dshSemantic?.languageFeatures ?? { definition: 0, tokens: 0, tokenData: 0 }
          if (window.__dshSemantic !== undefined) window.__dshSemantic.languageFeatures = featureDebug
          const disposers = []
          const selector = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'csharp', 'python']
          const sessionFor = () => currentSessionId(ctx)
          const sessionForModel = (model) => {
            try {
              const active = service.getActiveEditor?.()
              const activePath = active?.document?.path
              if (typeof activePath === 'string' && normalizePath(activePath) === normalizePath(modelFilePath(monaco, model))) {
                const sessionId = active?.document?.sessionId
                if (typeof sessionId === 'string' && sessionId !== '') return sessionId
              }
            } catch { /* fall back */ }
            return sessionFor()
          }

          disposers.push(monaco.languages.registerDefinitionProvider(selector, {
            provideDefinition: async (model, position) => {
              const sessionId = sessionForModel(model)
              const file = modelFilePath(monaco, model)
              if (sessionId === '' || file === '') return []
              featureDebug.definition += 1
              let data = null
              let results = []
              for (let attempt = 0; attempt < 3; attempt += 1) {
                data = await postSemantic('definition', {
                  sessionId,
                  file,
                  line: position.lineNumber,
                  column: position.column,
                })
                results = Array.isArray(data?.results) ? data.results : []
                if (results.length > 0) break
                await new Promise(resolve => setTimeout(resolve, 2_500))
              }
              featureDebug.lastDefinition = { sessionId, file, line: position.lineNumber, column: position.column, count: results.length }
              return results.map(item => ({
                uri: monaco.Uri.file(item.file),
                range: new monaco.Range(
                  item.line,
                  item.column ?? 1,
                  item.endLine ?? item.line,
                  Math.max(item.endColumn ?? item.column ?? 1, (item.column ?? 1) + 1),
                ),
              }))
            },
          }))

          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch { /* ignore */ }
            }
            window.__dshSemanticLanguageFeatures = false
          }
        } catch {
          return () => {}
        }
      })()
    }

    function installSemanticStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-semantic-style]') !== null) return
      const style = document.createElement('style')
      style.dataset.dshSemanticStyle = 'true'
      style.textContent = [
        '.dsh-sem-tok-class,.dsh-sem-tok-struct,.dsh-sem-tok-interface,.dsh-sem-tok-enum,.dsh-sem-tok-type,.dsh-sem-tok-typeParameter,.dsh-sem-tok-namespace{color:#4EC9B0!important}',
        '.dsh-sem-tok-method,.dsh-sem-tok-function,.dsh-sem-tok-macro,.dsh-sem-tok-decorator{color:#DCDCAA!important}',
        '.dsh-sem-tok-property,.dsh-sem-tok-field,.dsh-sem-tok-variable,.dsh-sem-tok-parameter{color:#9CDCFE!important}',
        '.dsh-sem-tok-keyword,.dsh-sem-tok-modifier,.dsh-sem-tok-operator{color:#569CD6!important}',
        '.dsh-sem-tok-string{color:#CE9178!important}',
        '.dsh-sem-tok-number,.dsh-sem-tok-constant{color:#B5CEA8!important}',
        '.dsh-sem-tok-comment{color:#6A9955!important}',
        '.dsh-sem-tok-enumMember{color:#4FC1FF!important}',
        '.dsh-sem-tok-event{color:#C586C0!important}',
      ].join('\n')
      document.head.appendChild(style)
    }

    function createClient(ctx) {
      installSemanticStyles()
      let disposed = false
      const debug = window.__dshSemantic ?? (window.__dshSemantic = { hasMonaco: false, markerUpdates: 0 })
      const service = ctx.get('monacoEditor')
      if (service === undefined || service === null) {
        debug.hasMonaco = false
        ctx.logger?.info?.('dsh-semantic: monacoEditor not available; diagnostics markers disabled')
        return () => {}
      }
      debug.hasMonaco = true
      debug.service = service
      debug.ctx = ctx
      const disposers = []
      const timers = new Set()
      let releaseLanguageFeatures = () => {}
      void installLanguageFeatures(ctx, service).then(release => {
        if (disposed) release()
        else releaseLanguageFeatures = release
      })

      const applyMarkers = async (sessionId, path) => {
        if (disposed) return
        try {
          await service.ready
          const active = service.getActiveEditor()
          if (active === undefined || active === null) return
          try {
            active.editor?.updateOptions?.({ 'semanticHighlighting.enabled': true })
          } catch { /* older Monaco */ }
          const doc = active.document
          if (doc === undefined || normalizePath(doc.path) !== normalizePath(path)) return
          const diagnostics = await fetchDiagnostics(sessionId, path)
          if (disposed) return
          const monaco = active.monaco ?? service.monaco
          if (monaco === undefined) return
          const markers = diagnostics.map(item => ({
            severity: severityOf(monaco, item.severity),
            message: item.message ?? '',
            source: item.source ?? 'lsp',
            ...(item.code === undefined ? {} : { code: String(item.code) }),
            startLineNumber: item.line,
            startColumn: item.column,
            endLineNumber: item.endLine ?? item.line,
            endColumn: item.endColumn ?? item.column,
          }))
          const model = active.editor?.getModel?.()
          if (model !== undefined && model !== null) {
            monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
            debug.markerUpdates = (debug.markerUpdates ?? 0) + 1
            debug.lastMarkers = markers.length
            debug.lastPath = path
            void applySemanticDecorations(active.editor, monaco, model, sessionId, path)
          }
        } catch (error) {
          ctx.logger?.warn?.('dsh-semantic: marker update failed: %s', error?.message ?? error)
        }
      }

      const semanticDecorations = new Map()

      const applySemanticDecorations = async (editor, monaco, model, sessionId, path, attempt = 0) => {
        if (disposed || editor === undefined || monaco === undefined || model === undefined) return
        try {
          const data = await postSemantic('tokens', { sessionId, file: path })
          const source = Array.isArray(data?.data) ? data.data : []
          if (source.length === 0 && attempt < 1) {
            setTimeout(() => {
              if (!disposed) void applySemanticDecorations(editor, monaco, model, sessionId, path, attempt + 1)
            }, 3_000)
            return
          }
          if (source.length === 0) return
          const types = Array.isArray(data?.legend?.tokenTypes) ? data.legend.tokenTypes : []
          const decorations = []
          let line = 0
          let character = 0
          for (let index = 0; index + 4 < source.length; index += 5) {
            const deltaLine = source[index]
            const deltaStart = source[index + 1]
            if (deltaLine === 0) character += deltaStart
            else {
              line += deltaLine
              character = deltaStart
            }
            const length = source[index + 2]
            const type = types[source[index + 3]] ?? 'type'
            decorations.push({
              range: new monaco.Range(line + 1, character + 1, line + 1, character + length + 1),
              options: { inlineClassName: `dsh-sem-tok dsh-sem-tok-${String(type).replace(/[^A-Za-z0-9_-]/g, '')}` },
            })
          }
          const previous = semanticDecorations.get(editor) ?? []
          const next = editor.deltaDecorations(previous, decorations)
          semanticDecorations.set(editor, next)
          debug.semanticTokens = source.length
        } catch {
          // Semantic coloring is additive; markers and F12 still work without it.
        }
      }

      const schedule = (sessionId, path) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          void applyMarkers(sessionId, path)
        }, 180)
        timers.add(timer)
      }

      const onOpen = (event) => {
        if (event?.sessionId && event?.path) schedule(event.sessionId, event.path)
      }
      const onSave = (event) => {
        if (event?.sessionId && event?.path) schedule(event.sessionId, event.path)
      }
      const onChange = (event) => {
        // Diagnostics only refresh after a save: the Host reads committed text.
        if (event?.sessionId && event?.path && event.dirty === false) schedule(event.sessionId, event.path)
      }

      for (const [name, handler] of [['onDidOpenDocument', onOpen], ['onDidSaveDocument', onSave], ['onDidChangeDocument', onChange]]) {
        const subscribe = service.events?.[name]
        if (typeof subscribe === 'function') {
          try {
            const off = subscribe(handler)
            if (typeof off === 'function') disposers.push(off)
          } catch (error) {
            ctx.logger?.warn?.('dsh-semantic: subscribe %s failed: %s', name, error?.message ?? error)
          }
        }
      }

      return () => {
        disposed = true
        releaseLanguageFeatures()
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        for (const dispose of disposers) {
          try { dispose() } catch { /* ignore */ }
        }
      }
    }

    function installWorkspaceFilesCompat(ctx) {
      // Native document preview and dsh-monaco both call workspaceFiles remote
      // methods. On current DSH builds those calls go through typert's
      // workspaceFileScope provider and can fail with "lookup provider ...
      // did not resolve the requested identity" for sidebar documents. Route
      // stat/readAll/readBytes through the semantic Host instead.
      try {
        const files = ctx.get('remote.workspaceFiles')
        if (files === undefined || files === null) return () => {}
        const saved = new Map()
        const define = (name, value) => {
          saved.set(name, Object.getOwnPropertyDescriptor(files, name))
          Object.defineProperty(files, name, { configurable: true, value })
        }
        const request = async (route, sessionId, path, signal) => {
          let root
          let id = sessionId
          try {
            const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
            if (typeof id !== 'string' || id === '') {
              id = Array.isArray(snapshot?.ids) ? snapshot.ids[snapshot.ids.length - 1] : id
            }
            const entry = snapshot?.byId?.[id]
            if (typeof entry?.cwd === 'string' && entry.cwd !== '') root = entry.cwd
          } catch { /* optional */ }
          const response = await fetch(`${API}/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: id, root, file: path }),
            signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json()
        }
        const bytesOf = (base64) => {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          return bytes
        }
        const original = (name) => typeof files[name] === 'function' ? files[name].bind(files) : undefined

        const statOriginal = original('stat')
        define('stat', async (sessionId, path, signal) => {
          try {
            const data = await request('stat', sessionId, path, signal)
            if (data?.ok === true) return { ok: true, value: data.value }
            return { ok: false, error: { code: 'workspace-file/not-found', message: String(data?.error ?? 'stat failed') } }
          } catch (error) {
            if (statOriginal !== undefined) return statOriginal(sessionId, path, signal)
            return { ok: false, error: { code: 'workspace-file/stat-failed', message: String(error?.message ?? error) } }
          }
        })

        const readAllOriginal = original('readAll')
        define('readAll', async (sessionId, path, signal) => {
          try {
            const data = await request('file', sessionId, path, signal)
            if (data?.ok !== true) return { ok: false, error: { code: 'workspace-file/read-failed', message: String(data?.error ?? 'read failed') } }
            return {
              ok: true,
              value: {
                absolutePath: data.value.absolutePath ?? path,
                version: String(data.value.version),
                offset: 0,
                data: bytesOf(data.value.data),
                eof: true,
              },
            }
          } catch (error) {
            if (readAllOriginal !== undefined) return readAllOriginal(sessionId, path, signal)
            return { ok: false, error: { code: 'workspace-file/read-failed', message: String(error?.message ?? error) } }
          }
        })

        const readBytesOriginal = original('readBytes')
        define('readBytes', async (sessionId, path, _options, signal) => {
          try {
            const data = await request('file', sessionId, path, signal)
            if (data?.ok !== true) return { ok: false, error: { code: 'workspace-file/read-failed', message: String(data?.error ?? 'read failed') } }
            return { ok: true, value: { data: bytesOf(data.value.data), version: String(data.value.version) } }
          } catch (error) {
            if (readBytesOriginal !== undefined) return readBytesOriginal(sessionId, path, _options, signal)
            return { ok: false, error: { code: 'workspace-file/read-failed', message: String(error?.message ?? error) } }
          }
        })

        return () => {
          for (const [name, descriptor] of saved) {
            try {
              if (descriptor !== undefined) Object.defineProperty(files, name, descriptor)
              else delete files[name]
            } catch { /* readonly service */ }
          }
        }
      } catch {
        return () => {}
      }
    }

    return {
      name: 'dsh-semantic',
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const debug = window.__dshSemantic ?? (window.__dshSemantic = { hasMonaco: false, markerUpdates: 0 })
        debug.ctx = ctx
        const releaseCompat = installWorkspaceFilesCompat(ctx)
        const tabDisposers = []
        try {
          const tabs = ctx.get('sidebarRightTabs')
          const slots = ctx.get('slots')
          const TAB_ID = 'dsh-semantic:diagnostics'
          tabDisposers.push(tabs.register({
            id: TAB_ID,
            kind: 'semantic-diagnostics',
            title: () => '诊断',
            guide: [{ order: 20, title: () => '诊断', description: () => 'LSP 错误和警告' }],
          }))
          tabDisposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, createDiagnosticsPanel(ctx))))
        } catch (error) {
          ctx.logger?.warn?.('dsh-semantic: diagnostics tab registration failed: %s', error?.message ?? error)
        }

        let dispose = () => {}
        let timer = null
        const attach = () => {
          if (ctx.get('monacoEditor') === undefined) return false
          dispose = createClient(ctx)
          return true
        }
        if (!attach()) {
          // The monaco client half and this bundle may boot in either order;
          // wait for the service instead of latching "no Monaco" too early.
          let attempts = 0
          timer = setInterval(() => {
            attempts += 1
            if (attach() || attempts >= 40) {
              clearInterval(timer)
              timer = null
            }
          }, 500)
        }
        ctx.effect(() => () => {
          if (timer !== null) clearInterval(timer)
          releaseCompat()
          dispose()
          for (const release of tabDisposers) {
            try { release() } catch { /* ignore */ }
          }
        }, 'dsh-semantic: diagnostics client')
      },
    }
  },
})
