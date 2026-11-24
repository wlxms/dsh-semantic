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
    const ReactDOM = require('react-dom')
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

    function createStatusPanel(ctx) {
      const COLLAPSED = 30
      const MAX_HEIGHT = 460
      const FONT = '12px/1.45 var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'
      const LABEL = 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, #888))'
      const BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,.2))'

      function Panel() {
        const [status, setStatus] = useState(null)
        const [bounds, setBounds] = useState(null)
        const [height, setHeight] = useState(() => {
          try { return Math.max(COLLAPSED, Number(localStorage.getItem('dsh-semantic-panel-height-v2')) || COLLAPSED) } catch { return COLLAPSED }
        })
        const [tab, setTab] = useState('progress')
        const [refs, setRefs] = useState(null)
        const expanded = height > 38
        const phase = status?.phase ?? 'idle'
        const phasePercent = phase === 'ready' ? 100 : phase === 'loading' ? 65 : phase === 'initializing' ? 35 : phase === 'starting' ? 15 : phase === 'error' ? 100 : 0
        const displayName = status?.displayName ?? 'LSP'
        const rawMessage = status?.message ?? '等待打开源文件'
        const summary = rawMessage.startsWith(displayName) ? rawMessage : `${displayName} · ${rawMessage}`

        useEffect(() => {
          const update = () => {
            const element = document.querySelector('[data-sidebar-right-panel]')
            if (element === null) { setBounds(null); return }
            const rect = element.getBoundingClientRect()
            if (rect.width < 120) { setBounds(null); return }
            setBounds({
              left: Math.round(rect.left),
              width: Math.round(rect.width),
              bottom: Math.max(0, Math.round(window.innerHeight - rect.bottom)),
            })
          }
          update()
          const timer = setInterval(update, 400)
          window.addEventListener('resize', update)
          return () => { clearInterval(timer); window.removeEventListener('resize', update) }
        }, [])

        useEffect(() => {
          let alive = true
          let lastWarmup = 0
          const load = async () => {
            const sessionId = activeSessionId(ctx)
            let cwd = ''
            try {
              const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
              cwd = snapshot?.byId?.[sessionId]?.cwd ?? ''
            } catch { /* optional */ }
            if (sessionId === '' && cwd === '') return
            try {
              const query = new URLSearchParams()
              if (sessionId !== '') query.set('sessionId', sessionId)
              if (cwd !== '') query.set('root', cwd)
              const response = await fetch(`${API}/status?${query.toString()}`)
              if (!response.ok) return
              const data = await response.json()
              if (alive) setStatus(data?.ok === false ? { phase: 'error', message: String(data.error ?? '工作区不可用') } : data)
              if (alive && data?.ok !== false && (data.phase === 'idle' || data.phase === 'initializing') && cwd !== '' && Date.now() - lastWarmup > 8_000) {
                lastWarmup = Date.now()
                void fetch(`${API}/warmup`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(sessionId === '' ? { root: cwd } : { sessionId, root: cwd }),
                }).catch(() => {})
              }
            } catch { /* ignore */ }
          }
          void load()
          const timer = setInterval(() => { void load() }, 1_200)
          return () => { alive = false; clearInterval(timer) }
        }, [])

        useEffect(() => {
          if (!expanded || tab !== 'terminal') return
          let alive = true
          const load = async () => {
            const sessionId = activeSessionId(ctx)
            let cwd = ''
            try {
              const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
              cwd = snapshot?.byId?.[sessionId]?.cwd ?? ''
            } catch { /* optional */ }
            if (sessionId === '' || cwd === '') return
            try {
              const response = await fetch(`/coderef/refs?sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}`)
              if (!response.ok) return
              const data = await response.json()
              if (alive) setRefs(data)
            } catch { /* coderef may be absent */ }
          }
          void load()
          const timer = setInterval(() => { void load() }, 4_000)
          return () => { alive = false; clearInterval(timer) }
        }, [expanded, tab])

        useEffect(() => {
          try { localStorage.setItem('dsh-semantic-panel-height-v2', String(height)) } catch { /* ignore */ }
        }, [height])

        useEffect(() => {
          // Reserve the panel height inside the sidebar instead of covering the
          // editor: the dock surface gives the preview/editor its available area.
          const surface = document.querySelector('[data-sidebar-right-panel] [data-dockkit-surface]')
          if (surface === null) return () => {}
          const previousHeight = surface.style.height
          surface.style.height = `calc(100% - ${height}px)`
          surface.style.minHeight = '0'
          return () => {
            surface.style.height = previousHeight
          }
        }, [height, bounds])

        if (bounds === null) return null

        const startDrag = (event) => {
          event.preventDefault()
          const startY = event.clientY
          const startHeight = height
          const move = (moveEvent) => {
            const maxHeight = Math.min(MAX_HEIGHT, Math.max(160, window.innerHeight * 0.55))
            setHeight(Math.max(COLLAPSED, Math.min(maxHeight, startHeight + startY - moveEvent.clientY)))
          }
          const up = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', up)
        }

        const logs = String(status?.stderr ?? '').split(/\r?\n/).filter(line => line.trim() !== '').slice(-80)
        const eventLines = (Array.isArray(status?.events) ? status.events : []).slice(-60).map(event => {
          try { return `[${new Date(event.at).toLocaleTimeString()}] ${event.message}` } catch { return String(event.message ?? '') }
        })
        const logLines = [...eventLines, ...logs]
        const commands = Array.isArray(refs?.commands) ? refs.commands.slice(-40).reverse() : []
        const files = Array.isArray(refs?.files) ? refs.files.slice(-20).reverse() : []
        const statusColor = phase === 'error' ? 'var(--dsw-alias-state-error, #e06c75)' : phase === 'ready' ? 'var(--dsw-alias-state-success, #4ec9b0)' : 'var(--dsw-alias-state-warning, #d9a441)'
        const tabButton = (id, label) => React.createElement('button', {
          key: id, type: 'button', onClick: () => setTab(id),
          style: {
            border: 'none', background: 'transparent', padding: '5px 7px', margin: '0 1px',
            color: tab === id ? 'var(--dsw-alias-label-primary)' : LABEL,
            font: FONT, fontSize: 11.5, cursor: 'pointer',
            borderBottom: tab === id ? '1.5px solid var(--dsw-alias-label-primary)' : '1.5px solid transparent',
          },
        }, label)

        return React.createElement('div', {
          'data-dsh-semantic-statusbar': 'true',
          style: {
            position: 'fixed', left: `${bounds.left}px`, width: `${bounds.width}px`, bottom: `${bounds.bottom}px`,
            zIndex: 2147482500, height: `${height}px`, display: 'flex', flexDirection: 'column',
            borderTop: `.5px solid ${BORDER}`, background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'var(--dsw-alias-label-primary, inherit)', font: FONT,
            boxShadow: expanded ? '0 -6px 18px rgba(0,0,0,.08)' : 'none',
            overflow: 'hidden', userSelect: 'none', boxSizing: 'border-box',
          },
        },
        React.createElement('div', {
          onPointerDown: startDrag,
          title: '拖动调整高度',
          style: { height: 5, flexShrink: 0, cursor: 'ns-resize', background: 'transparent' },
        }),
        React.createElement('div', {
          onClick: () => setHeight(expanded ? COLLAPSED : Math.max(200, height)),
          style: { display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px', height: 25, flexShrink: 0, cursor: 'pointer' },
        },
        React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: statusColor, flexShrink: 0 } }),
        React.createElement('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'var(--dsw-alias-label-primary)' } }, summary),
        React.createElement('span', { style: { marginLeft: 'auto', color: LABEL, fontSize: 11, whiteSpace: 'nowrap' } }, `${phasePercent}%`),
        React.createElement('span', { style: { color: LABEL, fontSize: 11, width: 14, textAlign: 'center' }, title: expanded ? '收起' : '展开' }, expanded ? '⌄' : '⌃')),
        expanded ? React.createElement(React.Fragment, null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', padding: '2px 4px', borderTop: `.5px solid ${BORDER}`, flexShrink: 0 } },
            tabButton('progress', '进度'),
            tabButton('logs', '日志'),
            tabButton('terminal', '终端')),
          React.createElement('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 10px 10px', fontSize: 12 } },
            tab === 'progress' ? React.createElement('div', null,
              React.createElement('div', { style: { height: 3, borderRadius: 2, background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,.14))', overflow: 'hidden', margin: '2px 0 9px' } },
                React.createElement('div', { style: { width: `${phasePercent}%`, height: '100%', background: statusColor, transition: 'width .3s' } })),
              React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '64px 1fr', gap: '3px 8px' } },
                React.createElement('span', { style: { color: LABEL } }, '阶段'),
                React.createElement('span', null, phase),
                React.createElement('span', { style: { color: LABEL } }, '信息'),
                React.createElement('span', null, status?.message ?? '—'),
                React.createElement('span', { style: { color: LABEL } }, 'Solution'),
                React.createElement('span', { style: { wordBreak: 'break-all' } }, status?.solution ?? '—'),
                React.createElement('span', { style: { color: LABEL } }, '根目录'),
                React.createElement('span', { style: { wordBreak: 'break-all' } }, status?.root ?? '—')),
              status?.error ? React.createElement('div', { style: { color: statusColor, marginTop: 6 } }, status.error) : null) :
            tab === 'logs' ? React.createElement('div', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-secondary)' } }, logLines.length > 0 ? logLines.join('\n') : '暂无 LSP 日志') :
            React.createElement('div', null,
              React.createElement('div', { style: { color: LABEL, marginBottom: 5 } }, '终端命令记录（只读）'),
              commands.length === 0 ? React.createElement('div', { style: { color: LABEL } }, '暂无命令记录') : commands.map((item, index) => React.createElement('div', { key: index, style: { padding: '1px 0', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, `$ ${item.command}`)),
              files.length > 0 ? React.createElement('div', { style: { marginTop: 8 } }, React.createElement('div', { style: { color: LABEL, marginBottom: 4 } }, '最近文件'), files.map((item, index) => React.createElement('div', { key: index, style: { padding: '1px 0', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, item.path))) : null)))
          : null)
      }
      return Panel
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
      let path = ''
      try {
        if (typeof model?.uri?.fsPath === 'string' && model.uri.fsPath !== '') path = model.uri.fsPath
      } catch { /* fall through */ }
      if (path === '') {
        try {
          path = decodeURIComponent(model.uri.path ?? '')
          if (!/^[A-Za-z]:/.test(path)) path = path.replace(/^\//, '')
        } catch {
          path = ''
        }
      }
      // LSP document identities are drive-letter case-sensitive on Windows even
      // though the filesystem is not; normalise `d:\...` to `D:\...`.
      return path.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
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
              for (let attempt = 0; attempt < 5; attempt += 1) {
                data = await postSemantic('definition', {
                  sessionId,
                  file,
                  line: position.lineNumber,
                  column: position.column,
                })
                results = Array.isArray(data?.results) ? data.results : []
                if (results.length > 0) break
                await new Promise(resolve => setTimeout(resolve, 3_000))
              }
              featureDebug.lastDefinition = { sessionId, file, line: position.lineNumber, column: position.column, count: results.length }
              const first = results[0]
              if (first !== undefined && typeof first.file === 'string' && service.openFile !== undefined) {
                const target = modelFilePath(monaco, { uri: monaco.Uri.file(first.file) })
                if (normalizePath(target) !== normalizePath(file)) {
                  // dsh-monaco mounts one preview tab at a time; opening the
                  // target ourselves is what enables cross-file F12. Do not
                  // await it: a large file must not freeze the F12 action.
                  featureDebug.lastCrossOpen = { file: first.file, at: Date.now() }
                  void Promise.resolve(service.openFile({ sessionId, path: first.file, line: first.line }))
                    .catch(error => { featureDebug.lastDefinition.error = String(error?.message ?? error) })
                  // Returning a same-file location suppresses Monaco's
                  // "No results found" toast while the target preview mounts.
                  return [{
                    uri: model.uri,
                    range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 1),
                  }]
                }
              }
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
          void fetch(`${API}/warmup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, file: path }),
          }).catch(() => {})
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
        let panelRoot = null
        let panelHost = null
        try {
          if (ReactDOM?.createRoot !== undefined) {
            const Panel = createStatusPanel(ctx)
            panelHost = document.createElement('div')
            panelHost.dataset.dshSemanticPanel = 'true'
            document.body.appendChild(panelHost)
            panelRoot = ReactDOM.createRoot(panelHost)
            panelRoot.render(React.createElement(Panel))
          }
        } catch (error) {
          ctx.logger?.warn?.('dsh-semantic: bottom panel mount failed: %s', error?.message ?? error)
        }

        ctx.effect(() => () => {
          if (timer !== null) clearInterval(timer)
          releaseCompat()
          dispose()
          try {
            panelRoot?.unmount?.()
            panelHost?.remove?.()
          } catch { /* ignore */ }
          for (const release of tabDisposers) {
            try { release() } catch { /* ignore */ }
          }
        }, 'dsh-semantic: diagnostics client')
      },
    }
  },
})
