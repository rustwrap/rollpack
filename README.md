# @rustwrap/webpack

A **webpack-compatible** Node API and CLI backed by the [Rolldown](https://rolldown.rs) bundler
(Rust / Oxc). Drop-in replacement for `webpack` in `pcf-scripts` and webpack-based pipelines —
**much smaller bundles** (rollup-grade tree-shaking) and **far faster builds**, while honouring the
webpack config/API surface.

## Why
Webpack bundles for Fluent-v9 PCF controls can approach the 5 MB PCF limit. Rolldown's tree-shaking
removes far more dead code. `@rustwrap/webpack` exposes the webpack Node API + tapable plugin lifecycle that
`pcf-scripts` and webpack plugins expect, and translates the config onto Rolldown.

### Measured (representative builds)
| Build | webpack | @rustwrap/webpack |
|---|---|---|
| Fluent-v9 PCF control | 0.84 MB | **0.73 MB** |
| Multi-entry client bundle (14 entries) | 2.37 MB | **2.06 MB** |

## Architecture
- **`lib/index.js`** — `webpack(options, cb)` factory + the full `webpack.*` namespace.
- **`lib/compiler.js`** — tapable `Compiler`/`Compilation`/`MultiCompiler` with the standard webpack
  lifecycle hooks (`run`, `make`, `thisCompilation`, `compilation`, `processAssets` (staged), `emit`,
  `afterEmit`, `done`, …). This is what lets **real third-party plugins** (`apply(compiler)`) run.
- **`lib/build.js`** — the `make` phase: runs Rolldown per entry and writes results into
  `compilation.assets` (the compiler emits them after plugins' `processAssets`).
- **`lib/loaders.js`** — runs real webpack loader chains (`module.rules`) via `loader-runner`.
- **`lib/css.js`** — native CSS pipeline (sass/less compile + style-inject or extract).
- **`lib/assets.js`** — asset modules. **`lib/plugins.js`** — built-in plugins.
- **`lib/template.js`** — output filename templates. **`lib/stats.js`** — Stats. **`lib/sourcemap.js`** — devtool.

## Use as a webpack override
```json
{
  "overrides": { "webpack": "npm:@rustwrap/webpack@^1" },
  "devDependencies": { "webpack": "npm:@rustwrap/webpack@^1" }
}
```
The CLI stubs unresolved webpack-only plugin requires (`terser-webpack-plugin`, `webpack-bundle-analyzer`,
`eslint-webpack-plugin`, …) so existing `webpack.config.js` files load unchanged.

## Requirements

**Node.js `^20.19.0 || ^22.13.0 || >=24`** (enforced via the package's `engines` field).

This is **not** an arbitrary floor — it is the exact intersection of the engine requirements of the
Rust toolchain this package is built on:

| Dependency | Requires | Why |
|---|---|---|
| `rolldown` (+ native binding) | `^20.19.0 \|\| >=22.12.0` | The N-API/V8 features the Rust binary uses were backported into each LTS line at Node **20.19.0** and **22.12.0**. |
| `eslint-scope` | `^20.19.0 \|\| ^22.13.0 \|\| >=24` | Follows ESLint's policy: active LTS lines only, skipping odd non-LTS majors (21.x, 23.x). |

Taking the **strictest** clause on each line yields the declared range. Reading it:

- `^20.19.0` → the **Node 20 LTS** line, from patch **.19** up (`>=20.19.0 <21`). Earlier 20.x patches
  lack the backported native feature.
- `^22.13.0` → the **Node 22 LTS** line, from patch **.13** up (`>=22.13.0 <23`). Note this is one
  patch higher than Rolldown's own `22.12.0` floor, because `eslint-scope` requires `22.13.0`.
- `>=24` → **Node 24+** (the next even LTS line and beyond).
- **Excluded:** Node ≤16 (EOL), 18.x, 21.x, 22.0–22.12, and 23.x — none satisfy every dependency.

> **Node 16 / 18 are not supported.** Rolldown 1.x and oxlint 1.x dropped them; the native Rust
> binaries will not run there. The `engines` field makes this an **immediate, named `EBADENGINE`
> warning** at install (or a hard failure under `engine-strict=true`/CI) instead of a cryptic deep
> crash inside the native module.

## Support matrix

### ✅ Supported
| Area | Notes |
|---|---|
| **Node API** | `webpack(options, cb)`, `webpack(options)`→Compiler (`run`/`watch`/`close`), **MultiCompiler** (array of configs → MultiStats), function config `(env,argv)=>…`. |
| **Plugin system** | Real **tapable** `Compiler`/`Compilation` hooks. `apply(compiler)` plugins run. `compilation.hooks.processAssets` is **stage-ordered**. `emitAsset`/`updateAsset`/`getAsset`/`deleteAsset`/`renameAsset`. `webpack.sources` (webpack-sources). |
| **entry** | string / array / object / `{import, filename}`; `[name]`. |
| **output** | `path`, `filename`, `chunkFilename`, `clean`, `publicPath` (asset URLs), `library` (string / `["NS","[name]"]` / `{name,type}`), `libraryTarget` → `var`/`window`/`assign`→iife, `umd`, `commonjs`/`commonjs2`→cjs, `module`→es, `amd`. |
| **Filename templates** | `[name]`, `[ext]`, `[base]`, `[path]`, `[query]`, `[id]`, `[hash]`, `[contenthash]`, `[chunkhash]` (with `:N`). |
| **mode** | `production`/`development`/`none` → minify on/off. |
| **module.rules (loaders)** | Real loader chains via `loader-runner`: `test`/`include`/`exclude`/`resourceQuery`/`oneOf`/`enforce:pre|post`/`use` array/`options`/custom loaders. JS/TS/JSX transpilation is done by **Oxc** (transpile-only loaders `ts-loader`/`babel-loader`/`swc-loader`/`esbuild-loader` are skipped — equivalent, faster). |
| **CSS** | Native: `.scss`/`.sass` (consumer's `sass`), `.less` (consumer's `less`), `.css`; style-injected, or **extracted** when `MiniCssExtractPlugin` is present. **CSS Modules** (`*.module.*`) are properly scoped via `postcss-modules` (scoped class names + `{local:scoped}` export map + `composes`). |
| **Asset modules** | `asset/resource` (emit + URL), `asset/inline` (data URI), `asset/source`, `asset` (auto by `parser.dataUrlCondition.maxSize`); `generator.filename`/`output.assetModuleFilename`. |
| **Node globals (browser target)** | Auto-polyfills `process`, `Buffer`, and `global` for `web` builds — parity with webpack's `ProvidePlugin`/node-libs-browser. Using real scope analysis (acorn + eslint-scope), a **`process` shim** (nextTick/env/platform/…), the **`buffer` package's `Buffer`**, and `global`→globalThis are injected **only into modules that reference them as free (unbound) identifiers**. So dependencies that assume Node (e.g. telemetry SDKs pulling in `readable-stream`/`buffer` such as `@aria/webjs-sdk`) work in the browser instead of throwing `process is not defined`. No-op on `target:'node'` and for code that never references them. |
| **externals** | object map / array / RegExp / sync-callback function (`({request},cb)` & `(ctx,req,cb)`) / `{root}` → external + `output.globals`. **Exact-request match** (webpack semantics): an entry like `{react:"React"}` externalizes `react` only, **not** subpaths like `react/jsx-runtime` (those are bundled, so e.g. the automatic JSX runtime keeps its `jsx`/`jsxs`). Externals are reachable from **both `import` and `require()`** — a bundled CommonJS dependency's internal `require("<external>")` is rewritten to the same global, so it never leaves a bare `require` (which would throw in the browser). |
| **TypeScript** | Transpiled by Oxc (types stripped, JSX per `tsconfig`). **Ambient `const enum` member accesses are inlined to literals** (tsc parity) by reading the const enums declared in the project's `.ts/.d.ts` and any pulled in via tsconfig `files`/`include` or triple-slash `/// <reference>` — without this, accesses like `XrmClientApi.Constants.X.Y` would survive as runtime references to a namespace that doesn't exist at runtime. Regular (non-const) `enum`s emit runtime objects as usual. |
| **resolve** | `alias`, `extensions`, `mainFields`, `mainFiles`, `conditionNames`, `modules`, `extensionAlias`, `symlinks`, `fallback` (`false`→empty module), nearest `tsconfig.json` paths. |
| **devtool (source maps)** | `source-map`, `inline-source-map`, `hidden-source-map`, `nosources-*`, `eval-*` (≈inline). Emits `.map` + `sourceMappingURL`. |
| **target** | `web` (default) and `node`/`node*` (→ Rolldown `platform:'node'`, node builtins external). |
| **optimization** | `minimize`; **`minimizer` TerserPlugin `terserOptions` mapped to Rolldown's minifier**: `compress.drop_console`/`drop_debugger`/`passes`/`ecma`(→target)/`keep_classnames`/`keep_fnames`, `mangle` on/off/`toplevel`/`keep_*`, `format.comments`→`legalComments`. `usedExports:false` disables tree-shaking. Tree-shaking + scope-hoisting are always on via Rolldown. |
| **Built-in plugins** | `DefinePlugin` (nested keys; **AST-aware** — replaces expressions only, never the contents of string/template literals or comments), `EnvironmentPlugin`, `ProvidePlugin` (**real free-variable scope analysis** via acorn + eslint-scope), `BannerPlugin`, `IgnorePlugin`, `NormalModuleReplacementPlugin`, `SourceMapDevToolPlugin`/`EvalSourceMapDevToolPlugin`, `ProgressPlugin`, `optimize.LimitChunkCountPlugin` (forces single chunk), `HotModuleReplacementPlugin`. |
| **Dev server / HMR** | `webpack serve` / `new webpack.DevServer(options, compiler)`. A single-entry browser build uses Rolldown 1.2's native **DevEngine**: per-client SSE patches, live module-graph boundary discovery, self/dependency acceptance, `dispose(data)`, `module.hot.data`, decline/invalidate/status handlers, state-preserving re-execution, and safe full reload when no boundary accepts an edit. `module.hot`, `import.meta.webpackHot`, and `import.meta.hot` share the native per-module context. Full outputs still pass through webpack `Compilation`, `processAssets`, `emit`, and `done` hooks. Tsconfig edits use Rolldown's native invalidation and full-reload signal. |
| **Third-party plugins** | Anything tapping `compilation.hooks.processAssets`/`compiler.hooks.emit`/`done`/etc. works (Copy-style, Html-style, Banner, analyzers). |
| **performance** | `hints`/`maxAssetSize` enforced (warning/error). |
| **ignoreWarnings** | RegExp / function filters. |
| **stats** | `Stats` with `hasErrors`/`hasWarnings`/`toJson`/`toString({colors})`; quiet via `stats:false|'none'|'errors-only'`. |
| **watch** | `compiler.watch` / `watch:true` with `watchOptions.aggregateTimeout`; native DevEngine watching/caching is used by eligible hot dev-server builds. |
| **code-splitting** | dynamic `import()` → chunks for **es/cjs** output (`output.chunkFilename`). |
| **Namespace** | `webpack.Compiler/Compilation/MultiCompiler/sources/WebpackError/util/ModuleFilenameHelpers/version`, all built-in plugins, `webpack.optimize.*`, `webpack.container.*`, `webpack.ids.*`. |

### ➖ Partial / approximated

| Feature | Exact limitation |
|---|---|
| **`optimization.splitChunks` / `cacheGroups` / `runtimeChunk`** | Rolldown owns chunking. Webpack cache-group, minimum-size, merge, and separate-runtime controls are not mapped. `LimitChunkCountPlugin({maxChunks:1})` is honored. |
| **`devtool: eval*`** | Produces a correct inline source map, not webpack's literal per-module `eval()` wrappers. |
| **HMR outside the native shape** | Native state-preserving HMR requires a single-entry browser DevServer build. Multi-entry and non-browser builds retain full-build/live-reload behavior. Updates are automatic; direct `module.hot.check()`/`apply()` calls are compatibility promises, not a manual update-download protocol. |
| **`experiments.lazyCompilation`** | In an eligible native dev-server build, `true` or `{imports:true}` lazily compiles dynamic imports through Rolldown's `compileEntry`. Lazy **entries**, `backend`, `test`, and webpack's filtering/backend protocol are not implemented. Rolldown 1.2 also has experimental lazy-chunk limits for link-stage synthesized JSON/text/data-url exports and non-inline lazy sourcemaps. |
| **`output.environment` / browserslist targets** | Oxc emits modern JavaScript; ES5 downleveling is unavailable. Only browser (`web`) and Node (`node*`) platform selection is translated. |
| **Persistent cache** | `cache: {type:"filesystem"}` is accepted but does not reproduce webpack's cache files, dependency snapshots, build dependencies, or invalidation contract. Rolldown uses its own in-memory/incremental caches. |
| **Advanced entry/output descriptors** | Entry `import`/`filename` and the output fields listed above are supported. `dependOn`, per-entry `runtime`/`layer`, custom chunk/wasm loading, hot-update filename templates, Trusted Types, and other webpack-runtime-specific output controls are ignored. |
| **Advanced dev-server options** | Static files, history fallback, host/port, watch and HMR are supported. Proxying, HTTPS certificates, websocket transport customization, browser opening, compression, middleware hooks, and webpack-dev-server's client overlay/options are not implemented. |

### ❌ Unsupported / compatibility-only exports

- **Module Federation and sharing runtime** — `container.ModuleFederationPlugin`, `webpack.sharing`,
  and `webpack.RuntimeGlobals` are namespace/no-op compatibility shims.
- **DLL builds** — `DllPlugin` and `DllReferencePlugin` are no-ops.
- **Async WebAssembly** — `experiments.asyncWebAssembly` and webpack's wasm loading runtime are not implemented.
- **Deep graph/template APIs** — no webpack `moduleGraph`, `chunkGraph`, dependency/template classes,
  parser factories, runtime modules, child-compilation graph, or equivalent internals for plugins that depend on them.
- **Context and ID plugins** — `ContextReplacementPlugin`, `HashedModuleIdsPlugin`, `NamedModulesPlugin`,
  and `NamedChunksPlugin` are load-compatible no-ops; Rolldown owns resolution and stable module/chunk identities.
- **Other exported no-op controls** — `WatchIgnorePlugin`, `LoaderOptionsPlugin`, `NoEmitOnErrorsPlugin`,
  `optimize.MinChunkSizePlugin`, `optimize.AggressiveMergingPlugin`, `optimize.RuntimeChunkPlugin`, and
  `optimize.SplitChunksPlugin`. `optimize.ModuleConcatenationPlugin` has no switch because Rolldown scope-hoists natively.
- **Non-web/Node targets and webpack runtimes** — Electron, NW.js, webworker-specific runtime behavior,
  JSONP/custom chunk loaders, and webpack's runtime/chunk manifest protocol are not reproduced.

## Test
`npm test` runs `test/run.js` — a synthetic feature matrix (69 assertions) covering tree-shaking,
multi-entry/MultiCompiler, Define/Environment/Banner, the loader system + CSS, custom plugins via
hooks, externals, source maps, `[contenthash]`, performance/ignoreWarnings, code-splitting,
Rolldown 1.2 import-meta/tree-shaking behavior, native HMR state/disposal/full-reload boundaries,
tsconfig invalidation, lazy dynamic imports, and the namespace.

## Engine & dependencies
Rolldown is the bundling engine. The other deps fall into two groups:
- **Engine / compat layer (actually used by `@rustwrap/webpack`):** `rolldown`, `loader-runner`,
  `webpack-sources`, `tapable`, `mime-types`, `acorn` + `eslint-scope` (ProvidePlugin scope
  analysis), `postcss` + `postcss-modules` (CSS Modules scoping).
- **webpack drop-in deps (declared so a normal `npm install` of the `webpack` override still
  resolves them, exactly like webpack would provide them transitively):** `terser-webpack-plugin`
  (consumer configs reference it in `optimization.minimizer`; `@rustwrap/webpack` reads its options and never
  calls `.apply()`), `schema-utils` (required by many third-party plugins). These mirror the
  packages webpack itself depends on, so existing `webpack.config.js` files keep working after the
  override. The CLI additionally stubs any *other* unresolved webpack-only plugin require
  (`webpack-bundle-analyzer`, `eslint-webpack-plugin`, …) as a safety net.

`@rustwrap/webpack` does not implement its own bundler — the engine is Rolldown.
