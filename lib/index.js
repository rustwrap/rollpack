"use strict";
/*
 * @rustwrap/webpack — a webpack-compatible Node API and CLI backed by the Rolldown bundler.
 *
 * This is the public entry: the `webpack(options, callback)` factory, the Compiler/Compilation
 * lifecycle (tapable hooks, so real plugins run), and the full `webpack.*` namespace. The actual
 * bundling + tree-shaking is done by Rolldown (see build.js); the rest of this package translates
 * the webpack config/API surface.
 */
const crypto = require("crypto");
const { Compiler, Compilation, MultiCompiler, sources } = require("./compiler");
const { runMake } = require("./build");
const plugins = require("./plugins");

function webpack(options, callback) {
  if (typeof options === "function") options = options(process.env, {}) || {};
  let compiler;
  if (Array.isArray(options)) compiler = new MultiCompiler(options.map((o) => createCompiler(o || {})));
  else compiler = createCompiler(options || {});
  if (typeof callback === "function") {
    const watch = Array.isArray(options) ? options.some((o) => o && o.watch) : options.watch;
    if (watch) {
      const wo = Array.isArray(options) ? (options[0].watchOptions || {}) : (options.watchOptions || {});
      return compiler.watch(wo, callback);
    }
    compiler.run(callback);
    return compiler;
  }
  return compiler;
}

function createCompiler(options) {
  const context = options.context || process.cwd();
  const compiler = new Compiler(context, options);
  compiler.$rustwrap = { define: {}, provide: {}, ignore: [], normalReplace: [] };
  compiler.hooks.environment.call();
  compiler.hooks.afterEnvironment.call();

  // Apply user plugins (real apply(compiler) — taps hooks / populates $rustwrap).
  for (const p of options.plugins || []) {
    try {
      if (p && typeof p.apply === "function") p.apply(compiler);
      else if (typeof p === "function") p.call(compiler, compiler);
    } catch (e) { /* a plugin that needs deep webpack internals — keep building */ }
  }
  compiler.hooks.afterPlugins.call(compiler);
  compiler.hooks.afterResolvers.call(compiler);

  // The make phase: Rolldown build -> compilation.assets.
  compiler.hooks.make.tapPromise("rustwrap", (compilation) => runMake(compilation, options, context));

  // After assets are produced: performance hints + ignoreWarnings (before Stats is created).
  compiler.hooks.afterEmit.tapPromise("rustwrap:post", async (compilation) => {
    applyPerformance(options, compilation);
    filterWarnings(options, compilation);
  });

  // Default console summary (unless stats are silenced).
  compiler.hooks.done.tapPromise("rustwrap:summary", async (stats) => {
    const quiet = options.stats === false || options.stats === "none" || options.stats === "errors-only"
      || (options.infrastructureLogging && (options.infrastructureLogging.level === "none" || options.infrastructureLogging.level === "error"));
    if (!quiet) printSummary(stats);
  });

  return compiler;
}

function applyPerformance(options, compilation) {
  const perf = options.performance;
  if (!perf || perf.hints === false) return;
  const max = perf.maxAssetSize || 250000;
  for (const name of Object.keys(compilation.assets)) {
    if (!/\.(js|mjs|cjs|css)$/.test(name)) continue;
    const size = bytes(compilation.assets[name].source());
    if (size > max) {
      const msg = `asset ${name} (${(size / 1024) | 0} KiB) exceeds the recommended size limit (${(max / 1024) | 0} KiB)`;
      (perf.hints === "error" ? compilation.errors : compilation.warnings).push({ message: msg });
    }
  }
}

function filterWarnings(options, compilation) {
  const ig = options.ignoreWarnings;
  if (!ig || !ig.length) return;
  compilation.warnings = compilation.warnings.filter((w) => !ig.some((rule) =>
    rule instanceof RegExp ? rule.test(w.message || "") : (typeof rule === "function" ? rule(w, compilation) : false)));
}

function bytes(c) { return Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c), "utf8"); }
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(2) + " MiB" : (b / 1024).toFixed(1) + " KiB"; }
function fmtTime(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms"; }
const C = (process.stdout.isTTY || process.env.FORCE_COLOR) ? { d: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", m: "\x1b[35m", r: "\x1b[0m" } : { d: "", b: "", g: "", c: "", y: "", m: "", r: "" };
function printSummary(stats) {
  const j = stats.toJson();
  const total = (j.assets || []).reduce((s, a) => s + a.size, 0);
  for (const e of j.errors || []) console.log(`${C.y}ERROR${C.r} ${e.message}`);
  for (const w of j.warnings || []) console.log(`${C.y}WARNING${C.r} ${w.message}`);
  console.log(`${C.c}${C.b}@rustwrap/webpack${C.r} ${C.g}${(j.assets || []).length} assets${C.r} ${C.m}${fmtSize(total)}${C.r} ${C.d}via rolldown in${C.r} ${C.y}${fmtTime(j.time || 0)}${C.r}`);
  for (const a of j.assets || []) console.log(`  ${C.d}asset${C.r} ${C.c}${a.name}${C.r}  ${C.m}${fmtSize(a.size)}${C.r}`);
}

// ---------------------------------------------------------------------------------------------
// Public namespace (webpack.*)
// ---------------------------------------------------------------------------------------------
class WebpackError extends Error { constructor(msg) { super(msg); this.name = "WebpackError"; } }

webpack.webpack = webpack;
webpack.Compiler = Compiler;
webpack.Compilation = Compilation;
webpack.MultiCompiler = MultiCompiler;
webpack.sources = sources;
webpack.WebpackError = WebpackError;
webpack.version = require("../package.json").version;
webpack.util = {
  createHash: (algo) => {
    const norm = (algo === "xxhash64" || algo === "md4") ? (crypto.getHashes().includes("md4") ? "md4" : "sha256") : (algo || "sha256");
    try { return crypto.createHash(norm); } catch (_) { return crypto.createHash("sha256"); }
  },
};
webpack.ModuleFilenameHelpers = {
  matchPart: (str, test) => test == null ? true : (test instanceof RegExp ? test.test(str) : (typeof test === "string" ? str.includes(test) : !!test)),
  matchObject: (obj, str) => {
    if (!obj) return true;
    if (obj.test && !webpack.ModuleFilenameHelpers.matchPart(str, obj.test)) return false;
    if (obj.include && !webpack.ModuleFilenameHelpers.matchPart(str, obj.include)) return false;
    if (obj.exclude && webpack.ModuleFilenameHelpers.matchPart(str, obj.exclude)) return false;
    return true;
  },
};
webpack.RuntimeGlobals = {};
webpack.DevServer = require("./dev-server.js");

// Built-in plugins
Object.assign(webpack, {
  DefinePlugin: plugins.DefinePlugin,
  EnvironmentPlugin: plugins.EnvironmentPlugin,
  ProvidePlugin: plugins.ProvidePlugin,
  BannerPlugin: plugins.BannerPlugin,
  IgnorePlugin: plugins.IgnorePlugin,
  NormalModuleReplacementPlugin: plugins.NormalModuleReplacementPlugin,
  ContextReplacementPlugin: plugins.ContextReplacementPlugin,
  SourceMapDevToolPlugin: plugins.SourceMapDevToolPlugin,
  EvalSourceMapDevToolPlugin: plugins.EvalSourceMapDevToolPlugin,
  ProgressPlugin: plugins.ProgressPlugin,
  LoaderOptionsPlugin: plugins.LoaderOptionsPlugin,
  HotModuleReplacementPlugin: plugins.HotModuleReplacementPlugin,
  WatchIgnorePlugin: plugins.WatchIgnorePlugin,
  DllPlugin: plugins.DllPlugin,
  DllReferencePlugin: plugins.DllReferencePlugin,
  HashedModuleIdsPlugin: plugins.HashedModuleIdsPlugin,
  NamedModulesPlugin: plugins.NamedModulesPlugin,
  NamedChunksPlugin: plugins.NamedChunksPlugin,
  NoEmitOnErrorsPlugin: plugins.NoEmitOnErrorsPlugin,
});
webpack.optimize = plugins.optimize;
webpack.container = plugins.container;
webpack.sharing = {};
webpack.web = {};
webpack.node = {};
webpack.ids = { HashedModuleIdsPlugin: plugins.HashedModuleIdsPlugin };

module.exports = webpack;
