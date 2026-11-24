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

## Analyzer / source-generator DLL locks

`csharp-ls` loads Roslyn analyzers and source generators from the workspace and keeps the
assemblies open for the lifetime of the process. This conflicts with UnrealSharp builds that
rewrite the same DLLs (`MSB3027` / file-in-use).

The C# server is spawned with a private MSBuild overlay (`CustomAfterMicrosoftCommonTargets`)
whose target copies every `@(Analyzer)` into

```text
$DSH_HOME/cache/lsp-analyzer-shadow/<workspace-hash>/
```

before the design-time build, then rewrites `@(Analyzer)` to the cached paths. `csharp-ls` locks
the cache copies, while the real generator/analyzer DLLs stay writable for normal builds.

- Normal MSBuild invocations are unaffected; the overlay is only in the LSP child environment.
- The cache is reused across LSP restarts and refreshed from the workspace on each load.
- Set `DSH_LSP_NO_ANALYZER_SHADOW=1` to disable the overlay if a generator misbehaves.
- Source-generator dependency DLLs that are not themselves `@(Analyzer)` items are still loaded
  from their original locations; only the analyzer assemblies themselves are shadow-copied.

## Security

Browser routes accept only same-origin/loopback requests. A `sessionId` is resolved to `ctx.sessions.get(sessionId).header.cwd`; the Host does not trust a client-supplied root for browser calls. Internal Host consumers may pass an absolute root through `ctx.semantic`.

## Test

```powershell
node test/semantic-smoke.mjs
```

The test builds a temporary TypeScript project, starts the bundled LSP server, checks `workspace/symbol` and `textDocument/publishDiagnostics`, then disposes the server.

## Dependencies

`vscode-jsonrpc`, `vscode-languageserver-protocol`, and `typescript` (for `typescript-language-server`'s tsserver). The LSP client design follows `dsh-lsp-diagnostics` (MIT) and adds the navigation/workspace-symbol operations it does not expose.

## Monaco compatibility note

DSH 0.1.5 exposes `remote.workspaceFiles.readAll` but not the newer `readBytes` method used by `@dsh-plugin/dsh-monaco@0.0.1`; the viewer can remain at `正在读取…`. This plugin installs a `readBytes -> readAll` compatibility shim, but the 0.0.1 viewer still requires a newer DSH document-preview runtime. On that DSH line the recommended setup is:

- do not bundle dsh-monaco; native sidebar preview renders the file;
- the semantic diagnostics tab lists errors/warnings.

On DSH versions compatible with dsh-monaco (>=0.2.2), install the matching Monaco version and the same client paints markers.

## Latest DSH compatibility (0.2.2)

DSH 0.2.2 introduced `workspaceFileScope` typert lookups for document preview. In migrated profiles the provider can fail with:

```text
typert gateway: workspaceFiles/stat: lookup provider "workspaceFileScope" did not resolve the requested identity
```

`dsh-semantic` now exposes `/semantic/stat` and `/semantic/file` (session cwd or absolute path) and the client proxies `workspaceFiles.stat`, `readAll`, and `readBytes` through them. This keeps both the native document preview and dsh-monaco usable on the latest runtime, including relative sidebar paths.
