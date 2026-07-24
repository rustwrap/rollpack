"use strict";
/*
 * Built-in webpack plugins. Bundler-affecting plugins (Define/Provide/Environment/Ignore/
 * NormalModuleReplacement) populate `compiler.$rustwrap`, which build.js reads during the Rolldown
 * make phase. Asset-affecting plugins (Banner) tap compilation.processAssets. The rest are faithful
 * no-ops or thin shims so configs load and run.
 */
const { STAGES } = require("./compiler");

function flattenDefinitions(defs, prefix, out) {
  for (const [k, v] of Object.entries(defs || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !(v instanceof RegExp) && !Array.isArray(v)) flattenDefinitions(v, key, out);
    else out[key] = typeof v === "string" ? v : (v instanceof RegExp ? v.toString() : JSON.stringify(v));
  }
  return out;
}

class DefinePlugin {
  constructor(definitions) { this.definitions = definitions || {}; }
  apply(compiler) { Object.assign(compiler.$rustwrap.define, flattenDefinitions(this.definitions, "", {})); }
}
DefinePlugin.runtimeValue = (fn, deps) => { const v = fn({}); return typeof v === "string" ? v : JSON.stringify(v); };

class EnvironmentPlugin {
  constructor(...keys) { this.keys = Array.isArray(keys[0]) ? keys[0] : (typeof keys[0] === "object" ? keys[0] : keys); }
  apply(compiler) {
    const d = compiler.$rustwrap.define;
    if (Array.isArray(this.keys)) for (const k of this.keys) d[`process.env.${k}`] = JSON.stringify(process.env[k] !== undefined ? process.env[k] : "");
    else for (const [k, def] of Object.entries(this.keys)) d[`process.env.${k}`] = JSON.stringify(process.env[k] !== undefined ? process.env[k] : def);
  }
}

class ProvidePlugin {
  constructor(definitions) { this.definitions = definitions || {}; }
  apply(compiler) { Object.assign(compiler.$rustwrap.provide, this.definitions); }
}

class BannerPlugin {
  constructor(options) { this.options = typeof options === "string" ? { banner: options } : (options || {}); }
  apply(compiler) {
    const o = this.options;
    const text = typeof o.banner === "function" ? o.banner : o.banner || "";
    const make = (filename) => {
      const raw = typeof text === "function" ? text({ filename }) : text;
      if (o.raw) return raw;
      return "/*! " + String(raw).replace(/\*\//g, "*\\/") + " */\n";
    };
    const test = o.test, include = o.include, exclude = o.exclude;
    const matches = (name) => {
      const m = (c, v) => c == null ? true : (c instanceof RegExp ? c.test(v) : (typeof c === "string" ? v.includes(c) : true));
      if (!m(test, name)) return false;
      if (include != null && !m(include, name)) return false;
      if (exclude != null && m(exclude, name) && exclude != null) return false;
      return /\.(js|mjs|cjs)$/.test(name) || test != null;
    };
    compiler.hooks.compilation.tap("BannerPlugin", (compilation) => {
      compilation.hooks.processAssets.tap({ name: "BannerPlugin", stage: STAGES.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE }, (assets) => {
        for (const name of Object.keys(assets)) {
          if (!matches(name)) continue;
          const src = assets[name];
          const cur = src.source();
          compilation.updateAsset(name, make(name) + (Buffer.isBuffer(cur) ? cur.toString("utf8") : cur));
        }
      });
    });
  }
}

class IgnorePlugin {
  constructor(options) { this.options = (options && options.resourceRegExp) ? options : { resourceRegExp: options && options.checkResource ? undefined : options, checkResource: options && options.checkResource }; }
  apply(compiler) { compiler.$rustwrap.ignore.push(this.options); }
}

class NormalModuleReplacementPlugin {
  constructor(resourceRegExp, newResource) { this.resourceRegExp = resourceRegExp; this.newResource = newResource; }
  apply(compiler) { compiler.$rustwrap.normalReplace.push([this.resourceRegExp, this.newResource]); }
}

class ContextReplacementPlugin {
  constructor(resourceRegExp, newContentResource) { this.resourceRegExp = resourceRegExp; this.newContentResource = newContentResource; }
  apply() {}
}

class SourceMapDevToolPlugin {
  constructor(options) { this.options = options || {}; }
  apply(compiler) { if (!compiler.options.devtool) compiler.options.devtool = this.options.inline ? "inline-source-map" : "source-map"; }
}
class EvalSourceMapDevToolPlugin {
  constructor(options) { this.options = options || {}; }
  apply(compiler) { if (!compiler.options.devtool) compiler.options.devtool = "inline-source-map"; }
}

class ProgressPlugin {
  constructor(handler) { this.handler = typeof handler === "function" ? handler : (handler && handler.handler); }
  apply(compiler) {
    if (!this.handler) return;
    compiler.hooks.run.tapPromise("ProgressPlugin", async () => { try { this.handler(0, "compiling"); } catch (_) {} });
    compiler.hooks.done.tapPromise("ProgressPlugin", async () => { try { this.handler(1, "done"); } catch (_) {} });
  }
}

// Faithful no-ops (single-file output / behaviors already covered by Rolldown).
class NoopPlugin { constructor(options) { this.options = options; } apply() {} }
class LimitChunkCountPlugin extends NoopPlugin {}
class MinChunkSizePlugin extends NoopPlugin {}
class AggressiveMergingPlugin extends NoopPlugin {}
class ModuleConcatenationPlugin extends NoopPlugin {}
class RuntimeChunkPlugin extends NoopPlugin {}
class SplitChunksPlugin extends NoopPlugin {}
class WatchIgnorePlugin extends NoopPlugin {}
class LoaderOptionsPlugin extends NoopPlugin {}
class HotModuleReplacementPlugin { apply(compiler) { compiler.$rustwrap = compiler.$rustwrap || {}; compiler.$rustwrap.hot = true; } }
class DllPlugin extends NoopPlugin {}
class DllReferencePlugin extends NoopPlugin {}
class HashedModuleIdsPlugin extends NoopPlugin {}
class NamedModulesPlugin extends NoopPlugin {}
class NamedChunksPlugin extends NoopPlugin {}
class NoEmitOnErrorsPlugin extends NoopPlugin {}
class ModuleFederationPlugin extends NoopPlugin {}

module.exports = {
  DefinePlugin, EnvironmentPlugin, ProvidePlugin, BannerPlugin, IgnorePlugin,
  NormalModuleReplacementPlugin, ContextReplacementPlugin, SourceMapDevToolPlugin,
  EvalSourceMapDevToolPlugin, ProgressPlugin, LoaderOptionsPlugin, HotModuleReplacementPlugin,
  WatchIgnorePlugin, DllPlugin, DllReferencePlugin, HashedModuleIdsPlugin, NamedModulesPlugin,
  NamedChunksPlugin, NoEmitOnErrorsPlugin,
  optimize: { LimitChunkCountPlugin, MinChunkSizePlugin, AggressiveMergingPlugin, ModuleConcatenationPlugin, RuntimeChunkPlugin, SplitChunksPlugin },
  container: { ModuleFederationPlugin },
};
