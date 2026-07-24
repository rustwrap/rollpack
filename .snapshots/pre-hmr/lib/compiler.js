"use strict";
/*
 * rollpack Compiler/Compilation — a tapable-based webpack lifecycle so real plugins (apply(compiler))
 * run. The heavy lifting (producing entry bundles) happens in the `make` phase via Rolldown; plugins
 * then add/modify compilation.assets through processAssets/emit hooks before they're written.
 */
const path = require("path");
const fs = require("fs");
const {
  SyncHook, SyncBailHook, AsyncSeriesHook, AsyncParallelHook, AsyncSeriesBailHook,
} = require("tapable");
const sources = require("webpack-sources");

const STAGES = {
  PROCESS_ASSETS_STAGE_ADDITIONAL: -2000,
  PROCESS_ASSETS_STAGE_PRE_PROCESS: -1000,
  PROCESS_ASSETS_STAGE_DERIVED: -200,
  PROCESS_ASSETS_STAGE_ADDITIONS: -100,
  PROCESS_ASSETS_STAGE_NONE: 0,
  PROCESS_ASSETS_STAGE_OPTIMIZE: 100,
  PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT: 200,
  PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY: 300,
  PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE: 400,
  PROCESS_ASSETS_STAGE_DEV_TOOLING: 500,
  PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE: 700,
  PROCESS_ASSETS_STAGE_SUMMARIZE: 1000,
  PROCESS_ASSETS_STAGE_OPTIMIZE_HASH: 2500,
  PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER: 3000,
  PROCESS_ASSETS_STAGE_ANALYSE: 4000,
  PROCESS_ASSETS_STAGE_REPORT: 5000,
};

function toSource(s) {
  if (s == null) return new sources.RawSource("");
  if (typeof s === "string" || Buffer.isBuffer(s)) return new sources.RawSource(s);
  if (typeof s.source === "function") return s; // already a Source
  return new sources.RawSource(String(s));
}

class Compilation {
  constructor(compiler) {
    this.compiler = compiler;
    this.options = compiler.options;
    this.outputOptions = compiler.options.output || {};
    this.assets = {};            // name -> Source
    this.assetsInfo = new Map(); // name -> info
    this.errors = [];
    this.warnings = [];
    this.chunks = new Set();
    this.modules = new Set();
    this.entrypoints = new Map();
    this.namedChunkGroups = new Map();
    this.hash = null;
    this.fullHash = null;
    this.name = compiler.name;
    const processAssets = new AsyncSeriesHook(["assets"]);
    this.hooks = {
      buildModule: new SyncHook(["module"]),
      succeedModule: new SyncHook(["module"]),
      finishModules: new AsyncSeriesHook(["modules"]),
      seal: new SyncHook([]),
      optimize: new SyncHook([]),
      optimizeModules: new SyncBailHook(["modules"]),
      optimizeChunks: new SyncBailHook(["chunks"]),
      optimizeTree: new AsyncSeriesHook(["chunks", "modules"]),
      optimizeChunkAssets: new AsyncSeriesHook(["chunks"]),
      optimizeAssets: new AsyncSeriesHook(["assets"]),
      afterOptimizeAssets: new SyncHook(["assets"]),
      processAssets,
      afterProcessAssets: new SyncHook(["assets"]),
      additionalAssets: new AsyncSeriesHook([]),
      chunkAsset: new SyncHook(["chunk", "filename"]),
      childCompiler: new SyncHook(["childCompiler", "compilerName", "compilerIndex"]),
      log: new SyncBailHook(["origin", "logEntry"]),
      additionalChunkAssets: new AsyncSeriesHook(["chunks"]),
      needAdditionalSeal: new SyncBailHook([]),
      afterSeal: new AsyncSeriesHook([]),
    };
    // webpack tags processAssets taps with a numeric `stage`; emulate by sorting taps by stage.
    patchStagedHook(processAssets);
  }

  emitAsset(name, source, info) {
    name = name.replace(/\\/g, "/");
    this.assets[name] = toSource(source);
    if (info) this.assetsInfo.set(name, info);
  }
  updateAsset(name, sourceOrFn, info) {
    name = name.replace(/\\/g, "/");
    const cur = this.assets[name];
    this.assets[name] = toSource(typeof sourceOrFn === "function" ? sourceOrFn(cur) : sourceOrFn);
    if (info) {
      const prev = this.assetsInfo.get(name) || {};
      this.assetsInfo.set(name, typeof info === "function" ? info(prev) : Object.assign({}, prev, info));
    }
  }
  getAsset(name) {
    name = name.replace(/\\/g, "/");
    if (!(name in this.assets)) return undefined;
    return { name, source: this.assets[name], info: this.assetsInfo.get(name) || {} };
  }
  deleteAsset(name) { name = name.replace(/\\/g, "/"); delete this.assets[name]; this.assetsInfo.delete(name); }
  renameAsset(oldName, newName) {
    if (this.assets[oldName]) { this.assets[newName] = this.assets[oldName]; this.assetsInfo.set(newName, this.assetsInfo.get(oldName) || {}); this.deleteAsset(oldName); }
  }
  getAssets() { return Object.keys(this.assets).map((name) => ({ name, source: this.assets[name], info: this.assetsInfo.get(name) || {} })); }
  emitError(e) { this.errors.push(e instanceof Error ? e : { message: String(e && e.message || e) }); }
  emitWarning(w) { this.warnings.push(w instanceof Error ? w : { message: String(w && w.message || w) }); }
  getPath(filename, data) { return require("./template").interpolateName(filename, data || {}); }
  getLogger() { const noop = () => {}; return new Proxy({}, { get: () => noop }); }
  getStats() { return require("./stats").createStats(this); }
}
Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL = STAGES.PROCESS_ASSETS_STAGE_ADDITIONAL;
Object.assign(Compilation, STAGES);

// Let plugins tap processAssets with { name, stage }; run taps ordered by ascending stage.
function patchStagedHook(hook) {
  const staged = [];
  const origTap = hook.tap.bind(hook);
  const origTapPromise = hook.tapPromise ? hook.tapPromise.bind(hook) : null;
  const origTapAsync = hook.tapAsync ? hook.tapAsync.bind(hook) : null;
  hook._stagedTaps = staged;
  const register = (opts, fn, kind) => {
    const stage = (typeof opts === "object" && opts.stage) || 0;
    staged.push({ stage, fn, kind, name: (typeof opts === "object" && opts.name) || "plugin" });
  };
  hook.tap = (opts, fn) => register(opts, fn, "sync");
  if (origTapPromise) hook.tapPromise = (opts, fn) => register(opts, fn, "promise");
  if (origTapAsync) hook.tapAsync = (opts, fn) => register(opts, fn, "async");
  hook.callStaged = async (assets) => {
    const ordered = staged.slice().sort((a, b) => a.stage - b.stage);
    for (const t of ordered) {
      if (t.kind === "sync") t.fn(assets);
      else if (t.kind === "promise") await t.fn(assets);
      else await new Promise((res, rej) => t.fn(assets, (e) => (e ? rej(e) : res())));
    }
  };
}

class Compiler {
  constructor(context, options) {
    this.context = context;
    this.options = options || {};
    this.name = this.options.name;
    this.outputPath = (this.options.output && this.options.output.path) || path.join(context, "dist");
    this.watchMode = false;
    this.running = false;
    this.hooks = {
      environment: new SyncHook([]),
      afterEnvironment: new SyncHook([]),
      afterPlugins: new SyncHook(["compiler"]),
      afterResolvers: new SyncHook(["compiler"]),
      initialize: new SyncHook([]),
      beforeRun: new AsyncSeriesHook(["compiler"]),
      run: new AsyncSeriesHook(["compiler"]),
      watchRun: new AsyncSeriesHook(["compiler"]),
      beforeCompile: new AsyncSeriesHook(["params"]),
      compile: new SyncHook(["params"]),
      thisCompilation: new SyncHook(["compilation", "params"]),
      compilation: new SyncHook(["compilation", "params"]),
      make: new AsyncParallelHook(["compilation"]),
      finishMake: new AsyncSeriesHook(["compilation"]),
      afterCompile: new AsyncSeriesHook(["compilation"]),
      shouldEmit: new SyncBailHook(["compilation"]),
      emit: new AsyncSeriesHook(["compilation"]),
      assetEmitted: new AsyncSeriesHook(["file", "info"]),
      afterEmit: new AsyncSeriesHook(["compilation"]),
      done: new AsyncSeriesHook(["stats"]),
      afterDone: new SyncHook(["stats"]),
      failed: new SyncHook(["error"]),
      invalid: new SyncHook(["filename", "changeTime"]),
      watchClose: new SyncHook([]),
      shutdown: new AsyncSeriesHook([]),
      infrastructureLog: new SyncBailHook(["origin", "type", "args"]),
    };
    this.outputFileSystem = fs;
    this.inputFileSystem = fs;
    this.webpack = require("./index.js");
  }

  getInfrastructureLogger() { const noop = () => {}; return new Proxy({}, { get: () => noop }); }

  newCompilation(params) {
    const compilation = new Compilation(this);
    this.hooks.thisCompilation.call(compilation, params || {});
    this.hooks.compilation.call(compilation, params || {});
    return compilation;
  }

  async run(callback) {
    this.running = true;
    const done = (err, stats) => { this.running = false; callback(err, stats); };
    try {
      await this.hooks.beforeRun.promise(this);
      await this.hooks.run.promise(this);
      const stats = await this.compile();
      await this.hooks.done.promise(stats);
      this.hooks.afterDone.call(stats);
      done(null, stats);
    } catch (err) {
      this.hooks.failed.call(err);
      done(err);
    }
  }

  async compile() {
    const params = {};
    await this.hooks.beforeCompile.promise(params);
    this.hooks.compile.call(params);
    const compilation = this.newCompilation(params);
    // make: produce entry bundles into compilation.assets (Rolldown), see build.runMake.
    await this.hooks.make.promise(compilation);
    await this.hooks.finishMake.promise(compilation);
    await this.hooks.afterCompile.promise(compilation);
    // seal-ish: run processAssets stages so plugins can add/transform assets.
    compilation.hooks.seal.call();
    await compilation.hooks.processAssets.callStaged(compilation.assets);
    compilation.hooks.afterProcessAssets.call(compilation.assets);
    await compilation.hooks.optimizeAssets.promise(compilation.assets);
    compilation.hooks.afterOptimizeAssets.call(compilation.assets);
    // emit
    if (this.hooks.shouldEmit.call(compilation) !== false) {
      await this.hooks.emit.promise(compilation);
      await this.emitAssets(compilation);
      await this.hooks.afterEmit.promise(compilation);
    }
    return compilation.getStats();
  }

  async emitAssets(compilation) {
    const outDir = this.outputPath;
    if (this.options.output && this.options.output.clean) {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    }
    for (const name of Object.keys(compilation.assets)) {
      const source = compilation.assets[name];
      const target = path.join(outDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = source.source();
      fs.writeFileSync(target, content);
      await this.hooks.assetEmitted.promise(name, { content: Buffer.isBuffer(content) ? content : Buffer.from(String(content)), targetPath: target, compilation });
    }
  }

  watch(watchOptions, handler) {
    this.watchMode = true;
    const root = this.context;
    let timer = null, building = false;
    const run = () => {
      building = true;
      this.hooks.watchRun.promise(this)
        .then(() => this.compile())
        .then((stats) => this.hooks.done.promise(stats).then(() => { building = false; handler(null, stats); }))
        .catch((e) => { building = false; this.hooks.failed.call(e); handler(e); });
    };
    run();
    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (_ev, f) => {
        if (f && /node_modules|[\\/](out|dist)[\\/]|\.d\.ts$/.test(f)) return;
        if (building) return;
        this.hooks.invalid.call(f, Date.now());
        clearTimeout(timer); timer = setTimeout(run, (watchOptions && watchOptions.aggregateTimeout) || 200);
      });
    } catch (_) {}
    return { close: (cb) => { clearTimeout(timer); if (watcher) watcher.close(); this.hooks.watchClose.call(); cb && cb(); }, invalidate: () => run() };
  }

  close(cb) { this.hooks.shutdown.promise().then(() => cb && cb(), (e) => cb && cb(e)); }
}

class MultiCompiler {
  constructor(compilers) {
    this.compilers = compilers;
    this.hooks = { done: new SyncHook(["stats"]), invalid: new SyncHook([]), run: new SyncHook(["compiler"]), watchClose: new SyncHook([]), watchRun: new SyncHook(["compiler"]) };
  }
  run(callback) {
    const allStats = [];
    let i = 0;
    const next = () => {
      if (i >= this.compilers.length) {
        const multi = makeMultiStats(allStats);
        this.hooks.done.call(multi);
        return callback(null, multi);
      }
      this.compilers[i++].run((err, stats) => { if (err) return callback(err); allStats.push(stats); next(); });
    };
    next();
  }
  watch(watchOptions, handler) {
    const watchers = this.compilers.map((c) => c.watch(watchOptions, (err, stats) => handler(err, stats)));
    return { close: (cb) => { let n = watchers.length; if (!n) return cb && cb(); watchers.forEach((w) => w.close(() => { if (--n === 0) cb && cb(); })); } };
  }
  close(cb) { let n = this.compilers.length; if (!n) return cb && cb(); this.compilers.forEach((c) => c.close(() => { if (--n === 0) cb && cb(); })); }
}

function makeMultiStats(statsArr) {
  return {
    stats: statsArr,
    hasErrors: () => statsArr.some((s) => s.hasErrors()),
    hasWarnings: () => statsArr.some((s) => s.hasWarnings()),
    toJson: (o) => ({ children: statsArr.map((s) => s.toJson(o)) }),
    toString: (o) => statsArr.map((s) => s.toString(o)).join("\n\n"),
  };
}

module.exports = { Compiler, Compilation, MultiCompiler, sources, STAGES, toSource };
