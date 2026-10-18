import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { ESLint } from 'eslint'
import nextPlugin from '@next/eslint-plugin-next'
import adapter from '../../vendor/fast-glob/index.cjs'

const pluginRequire = createRequire(import.meta.resolve('@next/eslint-plugin-next'))

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'linki-next-root-'))
  const pages = path.join(root, 'apps', 'one', 'pages')
  const nestedPages = path.join(root, 'apps', 'one', 'nested', 'pages')
  const otherPages = path.join(root, 'apps', 'two', 'pages')
  for (const directory of [pages, nestedPages, otherPages]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(path.join(pages, 'about.jsx'), 'export default function Page() {}')
  writeFileSync(path.join(nestedPages, 'private.jsx'), 'export default function Page() {}')
  writeFileSync(path.join(otherPages, 'contact.jsx'), 'export default function Page() {}')
  return root
}

async function lintLink(root, rootDir, href) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.jsx'],
      languageOptions: {
        ecmaVersion: 2022,
        parserOptions: { ecmaFeatures: { jsx: true } },
        sourceType: 'module',
      },
      plugins: { '@next/next': nextPlugin },
      rules: { '@next/next/no-html-link-for-pages': 'error' },
      settings: { next: { rootDir } },
    }],
  })
  const [result] = await eslint.lintText(
    `export default function Demo() { return <a href="${href}">Go</a> }`,
    { filePath: path.join(root, 'source.jsx') },
  )
  return result.messages.filter((message) => message.ruleId === '@next/next/no-html-link-for-pages')
}

test('directory glob adapter preserves Next root selection', () => {
  assert.equal(
    pluginRequire('fast-glob/package.json').description,
    'Scoped directory glob adapter for @next/eslint-plugin-next',
  )
  const root = fixture()
  try {
    const one = path.join(root, 'apps', 'one')
    const two = path.join(root, 'apps', 'two')
    assert.deepEqual(adapter.globSync(one, { onlyDirectories: true }), [one])
    assert.deepEqual(adapter.globSync(path.join(root, 'apps', '*'), { onlyDirectories: true }).sort(), [one, two])
    assert.deepEqual(adapter.globSync(path.join(root, 'apps', '**'), { onlyDirectories: true }).sort(), [
      one,
      path.join(one, 'nested'),
      path.join(one, 'nested', 'pages'),
      path.join(one, 'pages'),
      two,
      path.join(two, 'pages'),
    ].sort())
    assert.throws(() => adapter.globSync('apps/*', { onlyFiles: true }), /Unsupported fast-glob call/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Next link rule finds routes in absolute wildcard roots', async () => {
  const root = fixture()
  try {
    const rootDir = path.join(root, 'apps', '*')
    assert.equal((await lintLink(root, rootDir, '/about')).length, 1)
    assert.equal((await lintLink(root, rootDir, '/contact')).length, 1)
    assert.equal((await lintLink(root, rootDir, '/missing')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Next link rule keeps literal root narrow and recursive root broad', async () => {
  const root = fixture()
  try {
    const one = path.join(root, 'apps', 'one')
    assert.equal((await lintLink(root, one, '/about')).length, 1)
    assert.equal((await lintLink(root, one, '/private')).length, 0)
    assert.equal((await lintLink(root, path.join(root, 'apps', '**'), '/private')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
