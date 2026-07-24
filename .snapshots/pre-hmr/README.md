# rollpack

A **webpack-compatible** Node API and CLI backed by the [Rolldown](https://rolldown.rs) bundler
(Rust / Oxc). Drop-in replacement for `webpack` in `pcf-scripts` and webpack-based pipelines —
**much smaller bundles** (rollup-grade tree-shaking) and **far faster builds**, while honouring the
webpack config/API surface.

## Why
Webpack bundles for Fluent-v9 PCF controls can approach the 5 MB PCF limit. Rolldown's tree-shaking
removes far more dead code. rollpack exposes the webpack Node API + tapable plugin lifecycle that
`pcf-scripts` and webpack plugins expect, and translates the config onto Rolldown.

### Measured (real builds)
| Build | webpack | rollpack |
|---|---|---|
| EvaluationCriteria (PCF control) | 0.84 MB | **0.73 MB** |
| QMS Client Scripts (14 entries) | 2.37 MB | **2.06 MB** |

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
  "overrides": { "webpack": "npm:rollpack@^1" },
  "devDependencies": { "webpack": "npm:rollpack@^1" }
}
```
The CLI stubs unresolved webpack-only plugin requires (`terser-webpack-plugin`, `webpack-bundle-analyzer`,
`eslint-webpack-plugin`, …) so existing `webpack.config.js` files load unchanged.

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
| **externals** | object map / array / RegExp / sync-callback function (`({request},cb)` & `(ctx,req,cb)`) / `{root}` → external + `output.globals`. |
| **resolve** | `alias`, `extensions`, `mainFields`, `mainFiles`, `conditionNames`, `modules`, `extensionAlias`, `symlinks`, `fallback` (`false`→empty module), nearest `tsconfig.json` paths. |
| **devtool (source maps)** | `source-map`, `inline-source-map`, `hidden-source-map`, `nosources-*`, `eval-*` (≈inline). Emits `.map` + `sourceMappingURL`. |
| **target** | `web` (default) and `node`/`node*` (→ Rolldown `platform:'node'`, node builtins external). |
| **optimization** | `minimize`; **`minimizer` TerserPlugin `terserOptions` mapped to Rolldown's minifier**: `compress.drop_console`/`drop_debugger`/`passes`/`ecma`(→target)/`keep_classnames`/`keep_fnames`, `mangle` on/off/`toplevel`/`keep_*`, `format.comments`→`legalComments`. `usedExports:false` disables tree-shaking. Tree-shaking + scope-hoisting are always on via Rolldown. |
| **Built-in plugins** | `DefinePlugin` (nested keys), `EnvironmentPlugin`, `ProvidePlugin` (**real free-variable scope analysis** via acorn + eslint-scope), `BannerPlugin`, `IgnorePlugin`, `NormalModuleReplacementPlugin`, `SourceMapDevToolPlugin`/`EvalSourceMapDevToolPlugin`, `ProgressPlugin`, `optimize.LimitChunkCountPlugin` (forces single chunk), `LoaderOptionsPlugin`, `WatchIgnorePlugin`, `HotModuleReplacementPlugin` (enables `module.hot`), `ContextReplacementPlugin`. |
| **Dev server / HMR** | `rollpack serve` / `webpack serve` / `new webpack.DevServer(options, compiler)`. HTTP static serving (`static`), `historyApiFallback`, watch + rebuild, **SSE live-reload**, and a `module.hot`/`import.meta.hot` runtime so HMR-guarded code runs. (Hot updates apply via fast full reload — see Approximated.) |
| **Third-party plugins** | Anything tapping `compilation.hooks.processAssets`/`compiler.hooks.emit`/`done`/etc. works (Copy-style, Html-style, Banner, analyzers). |
| **performance** | `hints`/`maxAssetSize` enforced (warning/error). |
| **ignoreWarnings** | RegExp / function filters. |
| **stats** | `Stats` with `hasErrors`/`hasWarnings`/`toJson`/`toString({colors})`; quiet via `stats:false|'none'|'errors-only'`. |
| **watch** | `compiler.watch` / `watch:true` with `watchOptions.aggregateTimeout`. |
| **code-splitting** | dynamic `import()` → chunks for **es/cjs** output (`output.chunkFilename`). |
| **Namespace** | `webpack.Compiler/Compilation/MultiCompiler/sources/WebpackError/util/ModuleFilenameHelpers/version`, all built-in plugins, `webpack.optimize.*`, `webpack.container.*`, `webpack.ids.*`. |

### ➖ Approximated (faithful but not byte-identical to webpack)
- **`optimization.splitChunks` / cacheGroups / runtimeChunk** — Rolldown does its own chunking; the
  fine-grained cacheGroup controls are not mapped. Single-file output is preserved where required.
- **`devtool: eval` / `eval-source-map`** — emit a correct **inline source map** (full original
  sources, debuggable in devtools). The literal per-module `eval()` wrapping is a webpack-internal
  rebuild mechanism and isn't reproduced on a whole-bundle engine — the debugging result is equivalent.
- **HMR** — `module.hot`/`import.meta.hot` exist and run dispose handlers, but updates apply via a
  fast **full reload** (Rolldown emits a whole bundle, not webpack hot-update chunks), so module
  state is not preserved across edits.
- **`output.environment` / `target` browserslist downleveling** — Oxc emits modern JS; no ES5 downlevel.

### ❌ Not supported (Rolldown architecture / out of scope)
- **Module Federation** (`container.ModuleFederationPlugin` is a no-op), **DllPlugin**.
- **`experiments.asyncWebAssembly` / lazyCompilation**, persistent **`cache: {type:'filesystem'}`** semantics
  (accepted/ignored — Rolldown has its own caching).
- Deep `Compilation` graph internals (`moduleGraph`/`chunkGraph`/templates) that some advanced plugins reach into.

## Test
`npm test` runs `test/run.js` — a synthetic feature matrix (36 assertions) covering tree-shaking,
multi-entry/MultiCompiler, Define/Environment/Banner, the loader system + CSS, custom plugins via
hooks, externals, source maps, `[contenthash]`, performance/ignoreWarnings, code-splitting, and the
namespace.

## Engine & dependencies
Rolldown is the bundling engine. The other deps fall into two groups:
- **Engine / compat layer (actually used by rollpack):** `rolldown`, `loader-runner`,
  `webpack-sources`, `tapable`, `mime-types`, `acorn` + `eslint-scope` (ProvidePlugin scope
  analysis), `postcss` + `postcss-modules` (CSS Modules scoping).
- **webpack drop-in deps (declared so a normal `npm install` of the `webpack` override still
  resolves them, exactly like webpack would provide them transitively):** `terser-webpack-plugin`
  (consumer configs reference it in `optimization.minimizer`; rollpack reads its options and never
  calls `.apply()`), `schema-utils` (required by many third-party plugins). These mirror the
  packages webpack itself depends on, so existing `webpack.config.js` files keep working after the
  override. The CLI additionally stubs any *other* unresolved webpack-only plugin require
  (`webpack-bundle-analyzer`, `eslint-webpack-plugin`, …) as a safety net.

rollpack does not implement its own bundler — the engine is Rolldown.
