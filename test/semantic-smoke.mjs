// dsh-semantic smoke: starts the bundled TypeScript language server against a
// temporary project, then checks workspace symbols and diagnostics.
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticManager } from '../lib/lsp.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-semantic-'))
try {
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
    include: ['src/**/*.ts'],
  }))
  await writeFile(join(root, 'src', 'car.ts'), [
    'export class Car { public speed = 1; public drive(): void {} }',
    'export interface Driver { name: string }',
    'export class MyCar extends Car { public driver: Driver = { name: "x" } }',
  ].join('\n'))
  await writeFile(join(root, 'src', 'bad.ts'), 'export const broken: number = "not a number"\n')

  const manager = new SemanticManager(root)
  const symbols = await manager.resolveNames(['MyCar', 'Car.drive'])
  assert.ok(symbols.some(hit => hit.name === 'MyCar' && hit.line === 3), `workspace symbol missing: ${JSON.stringify(symbols)}`)
  assert.ok(symbols.some(hit => hit.name === 'drive'), `qualified member missing: ${JSON.stringify(symbols)}`)

  const diagnostics = await manager.diagnostics(join(root, 'src', 'bad.ts'))
  assert.ok(diagnostics.some(item => item.severity === 1 && item.line === 1), `diagnostics missing: ${JSON.stringify(diagnostics)}`)
  await manager.dispose()
  console.log('semantic-smoke: OK (workspace symbols + diagnostics)')
} finally {
  await new Promise(resolve => setTimeout(resolve, 500))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
