# dsh-semantic

Prototype semantic engine for DSH: LSP-backed symbol lookup plus diagnostics, consumable by the coderef plugin and other modules.

## Layers

- **Host half** (`lib/index.js`, `lib/lsp.js`)
  - Spawns one LSP server per workspace/language on demand.
  - `POST /semantic/resolve` — bare/`Class.field` to declarations via `workspace/symbol`.
  - `POST /semantic/definition` — position to definition.
  - `POST /semantic/diagnostics` — file diagnostics, or a bounded workspace scan when `file` is omitted.
  - `GET /semantic/status` — language, command, running/error state.
  - Exposes `ctx.semantic` (`resolve`, `definition`, `references`, `documentSymbols`, `diagnostics`, `status`).
- **Client half** (`lib/client.js`)
  - If `ctx.monacoEditor` exists, fetches diagnostics on open/save and paints Monaco model markers.
  - Always registers a native right-sidebar tab `语义诊断` as the no-Monaco fallback; it lists diagnostics and opens files at their line.
  - Never required by the semantic core; the Host route can be used without the client half.

## LSP servers

Configured in `lib/lsp.js`:

| Language | Command | Notes |
|---|---|---|
| TypeScript/JavaScript | `typescript-language-server --stdio` | uses the plugin's bundled `typescript@5.9.3` through `initializationOptions.tsserver.path` |
| Python | `pyright-langserver --stdio` | optional |
| C# | `csharp-ls` | tested with 0.28.0 + a `.csproj`; Unity workspaces without a generated solution have no project for csharp-ls, so they fall back to text resolution |

The workspace language is detected from `.sln/.csproj/.uproject`, `pyproject.toml/requirements.txt`, or `package.json/tsconfig.json`. A failed server is reported in `/semantic/status`; the coderef Host always falls back to evidence/text resolution.

## Security

Browser routes accept only same-origin/loopback requests. A `sessionId` is resolved to `ctx.sessions.get(sessionId).header.cwd`; the Host does not trust a client-supplied root for browser calls. Internal Host consumers may pass an absolute root through `ctx.semantic`.

## Test

```powershell
node test/semantic-smoke.mjs
```

The test builds a temporary TypeScript project, starts the bundled LSP server, checks `workspace/symbol` and `textDocument/publishDiagnostics`, then disposes the server.

## Dependencies

`vscode-jsonrpc`, `vscode-languageserver-protocol`, and `typescript` (for `typescript-language-server`'s tsserver). The LSP client design follows `dsh-lsp-diagnostics` (MIT) and adds the navigation/workspace-symbol operations it does not expose.
