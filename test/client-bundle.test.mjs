/**
 * 客户端半边（浏览器 bundle）的**行为**契约测试。
 *
 * `lib/client.js` 是**手写**的 `window.__ModuleLoader__.load({ id, factory })` bundle
 * （刻意不引 esbuild，见 discussion #5899 的结论：约定只要求这层 wrapper）。
 * 手写意味着没有构建器帮我们保证形状 —— 所以这里**真的把它跑一遍**，
 * 而不是断言源码文本。
 *
 * 契约来源：`docs/evidence/B0-ui-contract-findings.md` §2
 * （活样例 `@weibaohui/experts-management/client/bundle.js`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const clientSource = readFileSync(join(repoRoot, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

/** 在假 window 里执行 bundle，捕获它向加载器注册的 spec。 */
function loadBundle({ requireImpl } = {}) {
  let captured
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  const fakeRequire = requireImpl ?? ((id) => {
    throw new Error(`seeded require table 里没有 ${id}`)
  })
  // bundle 是脚本（非 ESM），用 Function 构造一个隔离作用域喂给它 window/require。
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'React', clientSource)(fakeWindow, fakeRequire, undefined)
  return captured
}

test('client: 必须走 window.__ModuleLoader__.load({ id, factory }) 这层约定', () => {
  const spec = loadBundle()
  assert.ok(spec, '未调用 __ModuleLoader__.load —— web boot 会整体中止')
  assert.equal(typeof spec.factory, 'function', 'factory 必须是惰性 CJS 工厂')
})

test('client: spec.id 必须等于 package.json 的 name（加载器用它做模块表键）', () => {
  const spec = loadBundle()
  assert.equal(spec.id, pkg.name)
})

test('client: factory 返回 { name, inject, apply }，且 inject 静态声明 slots+locale', () => {
  const spec = loadBundle()
  const mod = spec.factory((id) => {
    throw new Error(`no ${id}`)
  })
  assert.ok(mod && typeof mod === 'object')
  assert.equal(typeof mod.name, 'string')
  assert.equal(typeof mod.apply, 'function')
  // ⚠️ 必须静态声明：Cordis 对未声明 inject 的服务属性访问**直接抛错**，
  // 且 `ctx.locale && …` 这类守卫救不了（抛在读属性的那一刻）。
  // 漏声明过一次 → 客户端入口激活失败 → web boot 中止、DSH 无法启动（CHANGELOG 0.1.12）。
  assert.deepEqual(mod.inject, ['slots', 'locale'])
})

test('client: 注册设置分区走 ctx.slots.inject(name, () => register(spec, Component))', () => {
  const spec = loadBundle()
  const mod = spec.factory(() => {
    throw new Error('no react')
  })
  const registered = []
  const injected = []
  const fakeCtx = {
    slots: {
      inject(name, thunk) {
        injected.push(name)
        return thunk()
      },
      register(spec2, component) {
        registered.push({ spec: spec2, component })
      },
    },
    locale: {
      register() {},
      bind() {
        return (k) => k
      },
    },
    effect(fn) {
      return fn?.()
    },
  }
  mod.apply(fakeCtx)
  assert.ok(injected.includes('settings.section'), `未注册设置分区，实际注入：${JSON.stringify(injected)}`)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.section')
  assert.equal(typeof registered[0].spec.label, 'function')
})

test('client: 不依赖任何 @deepseek-ai/* 客户端包（dsh.client.inject 保持为空是合法的）', () => {
  // 宿主原文（app.asar）："Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load
  // any other Harness Client package as a module; `dsh.client.inject` entries only order
  // activation and stay allowed." —— 也就是说 inject 不是导入白名单，而是**激活顺序**。
  // 工作样例 @weibaohui/experiments-management 同为 slots+locale 用法，其 dsh.client 也只有 platform。
  assert.deepEqual(pkg.dsh.client, { platform: 'web' })
  assert.ok(!/require\(['"]@deepseek-ai\//.test(clientSource), 'bundle 不得 require Harness Client 包')
})

test('client: 数据面只打宿主自己的 /multi-acp 路由（同源 fetch）', () => {
  const urls = [...clientSource.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1])
  assert.ok(urls.length > 0, '未找到任何 fetch —— 设置面板将无法读写引擎')
  for (const u of urls) {
    assert.ok(u.startsWith('/multi-acp'), `越权/跨源请求：${u}`)
  }
})

test('client: bundle 里不得出现 ESM 顶层 import/export（它会被当脚本执行）', () => {
  assert.ok(!/^\s*import\s/m.test(clientSource), '顶层 import 会让加载器解析失败')
  assert.ok(!/^\s*export\s/m.test(clientSource), '顶层 export 会让加载器解析失败')
})
