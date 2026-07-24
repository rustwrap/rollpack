"use strict";
/*
 * build.js — the Rolldown "make" phase. Produces each entry's bundle and writes the result into
 * compilation.assets (the Compiler emits them later, after plugins' processAssets hooks). Integrates
 * the loader system, asset modules, Define/Provide/Ignore/NormalModuleReplacement, source maps,
 * target/platform, externals and library output formats.
 */
const path = require("path");
const { rolldown } = require("rolldown");
const { normalizeEntries, buildExternals, buildResolve, buildDefine } = require("./config");
const { loaderPlugin } = require("./loaders");
const { devtoolToRolldown } = require("./sourcemap");

// Non-JS extensions whose content our loader/asset plugin turns into JS — tell Rolldown to treat the
// load() output as JS (Rolldown otherwise infers type from extension and rejects e.g. CSS).
const NON_JS_EXT = [
  ".css", ".scss", ".sass", ".less", ".styl", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".txt", ".md", ".mdx",
  ".html", ".htm", ".xml", ".csv", ".tsv", ".vue", ".graphql", ".gql", ".pug", ".hbs", ".ejs",
];
function nonJsModuleTypes() { const m = {}; for (const e of NON_JS_EXT) m[e] = e === ".svg" ? "jsx" : "js"; return m; }

function targetPlatform(target) {
  const t = Array.isArray(target) ? target : [target];
  if (t.includes("node") || t.some((x) => typeof x === "string" && /^node/.test(x))) return "node";
  return "browser";
}

function readMinimize(cfg) {
  if (cfg.optimization && typeof cfg.optimization.minimize === "boolean") return cfg.optimization.minimize;
  return cfg.mode !== "development" && cfg.mode !== "none";
}
function readDropConsole(cfg) {
  const min = cfg.optimization && cfg.optimization.minimizer;
  for (const p of Array.isArray(min) ? min : []) {
    const t = p && (p.options || p);
    const c = t && t.terserOptions && t.terserOptions.compress;
    if (c && c.drop_console) return true;
  }
  return false;
}

function esTarget(ecma) {
  if (ecma == null) return undefined;
  const n = String(ecma);
  if (n === "5") return "es5";
  if (/^20\d\d$/.test(n)) return "es" + n;
  if (/^es/i.test(n)) return n.toLowerCase();
  return undefined;
}

// Map a TerserPlugin's `terserOptions` (in optimization.minimizer) to Rolldown's MinifyOptions, so
// drop_console/drop_debugger, mangle (on/off/toplevel/keep_*), passes, ecma target and comment
// handling are honored — not just drop_console. Returns false/true/MinifyOptions.
function buildMinify(cfg, minimize) {
  if (!minimize) return false;
  const min = cfg.optimization && cfg.optimization.minimizer;
  let terser = null;
  for (const p of Array.isArray(min) ? min : []) {
    const opts = (p && p.options) || {};
    if (opts.terserOptions) { terser = opts.terserOptions; break; }
    const cn = p && p.constructor && p.constructor.name;
    if (cn === "TerserPlugin") { terser = opts.terserOptions || {}; break; }
  }
  if (!terser) return true;
  const t = terser;
  const out = {};
  // compress
  if (t.compress === false) {
    out.compress = false;
  } else {
    const c = (t.compress && typeof t.compress === "object") ? t.compress : {};
    const compress = {};
    if (c.drop_console != null) compress.dropConsole = !!c.drop_console;
    if (c.drop_debugger != null) compress.dropDebugger = !!c.drop_debugger;
    if (c.passes != null) compress.maxIterations = c.passes;
    if (c.sequences === false) compress.sequences = false;
    const tgt = esTarget(t.ecma || c.ecma);
    if (tgt) compress.target = tgt;
    if (t.keep_classnames || c.keep_classnames || t.keep_fnames || c.keep_fnames) compress.keepNames = { function: !!(t.keep_fnames || c.keep_fnames), class: !!(t.keep_classnames || c.keep_classnames) };
    if (Object.keys(compress).length) out.compress = compress;
  }
  // mangle
  if (t.mangle === false) {
    out.mangle = false;
  } else {
    const mo = (t.mangle && typeof t.mangle === "object") ? t.mangle : {};
    const m = {};
    if (mo.toplevel != null || t.toplevel != null) m.toplevel = !!(mo.toplevel != null ? mo.toplevel : t.toplevel);
    if (mo.keep_classnames || mo.keep_fnames || t.keep_classnames || t.keep_fnames) m.keepNames = { function: !!(mo.keep_fnames || t.keep_fnames), class: !!(mo.keep_classnames || t.keep_classnames) };
    if (Object.keys(m).length) out.mangle = m;
  }
  // comments (terserOptions.format.comments / output.comments)
  const comments = (t.format && t.format.comments !== undefined) ? t.format.comments : (t.output && t.output.comments);
  if (comments !== undefined) {
    out.codegen = { legalComments: comments === false ? "none" : (comments === "all" || comments === true ? "inline" : "eof") };
  }
  return Object.keys(out).length ? out : true;
}

// PCF and other single-bundle setups force one chunk via LimitChunkCountPlugin({maxChunks:1}).
function singleChunkForced(cfg) {
  for (const p of cfg.plugins || []) {
    const n = p && p.constructor && p.constructor.name;
    if (n === "LimitChunkCountPlugin" && p.options && typeof p.options.maxChunks === "number" && p.options.maxChunks <= 1) return true;
  }
  return false;
}

// Map webpack chunkFilename tokens to Rolldown's ([contenthash]/[chunkhash] -> [hash], [id] -> [name]).
function convertChunkTemplate(t) {
  return String(t).replace(/\[(content|chunk)hash(?::\d+)?\]/g, "[hash]").replace(/\[id\]/g, "[name]").replace(/^\.?[\\/]/, "");
}

// ---- Rolldown plugins for Define / Provide / Ignore / NormalModuleReplacement -------------------
function definePlugin(define) {
  const keys = Object.keys(define).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\w$.])(${escaped.join("|")})(?![\\w$])`, "g");
  return {
    name: "rollpack:define",
    transform(code, id) {
      if (/[/\\]node_modules[/\\]/.test(id) && !/process\.env|typeof process|__DEV__/.test(code)) return null;
      re.lastIndex = 0;
      if (!re.test(code)) return null;
      re.lastIndex = 0;
      return { code: code.replace(re, (m) => (define[m] != null ? define[m] : m)), map: null };
    },
  };
}

function providePlugin(provide, _context) {
  const entries = Object.entries(provide || {});
  if (!entries.length) return null;
  const acorn = require("acorn");
  const eslintScope = require("eslint-scope");
  const simple = entries.filter(([k]) => !k.includes("."));
  return {
    name: "rollpack:provide",
    transform(code, id) {
      if (/\.(css|scss|sass|less|svg)$/.test(id) || !simple.length) return null;
      if (!simple.some(([k]) => code.includes(k))) return null;
      let ast;
      try {
        ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
      } catch (_) { return null; } // unparseable (already-CJS/odd) — skip rather than break the build
      let manager;
      try { manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module", ignoreEval: true, optimistic: true }); }
      catch (_) { return null; }
      // Truly free references = those that never resolved to a binding (bubble to the global scope).
      const free = new Set(manager.globalScope.through.map((r) => r.identifier.name));
      let header = "";
      for (const [name, spec] of simple) {
        if (!free.has(name)) continue;
        const local = `__rp_provide_${name.replace(/[^\w$]/g, "_")}`;
        if (Array.isArray(spec)) {
          if (spec.length > 1) header += `import { ${spec[1]} as ${local} } from ${JSON.stringify(spec[0])};\n`;
          else header += `import ${local} from ${JSON.stringify(spec[0])};\n`;
        } else {
          header += `import ${local} from ${JSON.stringify(spec)};\n`;
        }
        header += `var ${name} = ${local};\n`;
      }
      if (!header) return null;
      return { code: header + code, map: null };
    },
  };
}

function ignorePlugin(ignores) {
  if (!ignores || !ignores.length) return null;
  const matches = (request, ctx) => ignores.some((opt) => {
    if (!opt) return false;
    if (opt.resourceRegExp && !opt.resourceRegExp.test(request)) return false;
    if (opt.resourceRegExp && opt.resourceRegExp.test(request)) { if (opt.contextRegExp) return opt.contextRegExp.test(ctx || ""); return true; }
    if (typeof opt.checkResource === "function") return opt.checkResource(request, ctx);
    return false;
  });
  const VID = "\0rollpack-ignored";
  return {
    name: "rollpack:ignore",
    resolveId(source, importer) { if (matches(source, importer && path.dirname(importer))) return VID; return null; },
    load(id) { if (id === VID) return "export default {};"; return null; },
  };
}

function normalReplacePlugin(replacements) {
  if (!replacements || !replacements.length) return null;
  return {
    name: "rollpack:normal-replace",
    resolveId(source, importer) {
      for (const [re, repl] of replacements) {
        if (re.test(source)) {
          let target = typeof repl === "function" ? (() => { const r = { request: source }; repl(r); return r.request; })() : repl;
          if (target && !path.isAbsolute(target) && importer) target = path.resolve(path.dirname(importer), target);
          return this.resolve ? this.resolve(target, importer, { skipSelf: true }) : target;
        }
      }
      return null;
    },
  };
}

function entryRel(e, chunkFileName) {
  const rel = (e.filename || chunkFileName).replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  return rel;
}

async function runMake(compilation, cfg, context) {
  const compiler = compilation.compiler;
  const rp = compiler.$rollpack || {};
  const prod = cfg.mode !== "development" && cfg.mode !== "none";
  const minimize = readMinimize(cfg);
  const entries = normalizeEntries(cfg, context);
  const ext = buildExternals(cfg, context);
  const define = buildDefine(cfg, prod, rp.define);
  // When hot is enabled (dev server or HotModuleReplacementPlugin), make `module.hot` /
  // `import.meta.hot` resolve to the injected client runtime so HMR-guarded code runs.
  if (rp.hot) {
    define["module.hot"] = "(typeof window!=='undefined'&&window.__rollpack_hot__)";
    define["import.meta.hot"] = "(typeof window!=='undefined'&&window.__rollpack_hot__)";
  }
  const resolve = buildResolve(cfg, context);
  const { sourcemap } = devtoolToRolldown(cfg.devtool);
  const platform = targetPlatform(cfg.target);
  const moduleTypes = nonJsModuleTypes();
  const minifyOpt = buildMinify(cfg, minimize);
  const plugins = [
    ignorePlugin(rp.ignore),
    normalReplacePlugin(rp.normalReplace),
    loaderPlugin(cfg, context, compilation),
    providePlugin(rp.provide, context),
    definePlugin(define),
  ].filter(Boolean);

  const t0 = Date.now();
  compilation.__startTime = t0;

  for (const e of entries) {
    let bundle;
    try {
      bundle = await rolldown({
        input: e.input,
        external: ext.isExternal,
        platform,
        treeshake: cfg.optimization && cfg.optimization.usedExports === false ? false : true,
        resolve,
        moduleTypes,
        plugins,
        onLog: () => {},
      });
      const minifyOptForEntry = minifyOpt;
      const codeSplitting = (e.format === "es" || e.format === "cjs") && !singleChunkForced(cfg) && entries.length === 1;
      const chunkTmpl = convertChunkTemplate((cfg.output && cfg.output.chunkFilename) || "[name].js");
      const gen = await bundle.generate({
        format: e.format,
        name: e.libraryName || undefined,
        extend: e.extend,
        globals: ext.globals,
        minify: minifyOptForEntry,
        codeSplitting,
        chunkFileNames: chunkTmpl,
        sourcemap,
      });
      for (const o of gen.output) {
        if (o.type === "chunk") {
          let code = o.code != null ? o.code : "";
          const rel0 = o.isEntry ? entryRel(e, o.fileName) : o.fileName.replace(/\\/g, "/");
          const rel = require("./template").interpolateName(rel0, { name: o.isEntry ? e.name : path.basename(rel0, path.extname(rel0)), chunkName: e.name, id: e.name, content: code, ext: path.extname(rel0) || ".js" });
          if (o.map && sourcemap && sourcemap !== "inline") {
            const mapName = rel + ".map";
            compilation.emitAsset(mapName, typeof o.map === "string" ? o.map : JSON.stringify(o.map));
            if (sourcemap !== "hidden") code += `\n//# sourceMappingURL=${path.posix.basename(mapName)}`;
          }
          compilation.emitAsset(rel, code);
        } else {
          // Rolldown also emits the sourcemap as a separate asset named after the chunk's default
          // fileName; we already emit the map (renamed to match the entry) from chunk.map above.
          if (/\.map$/.test(o.fileName)) continue;
          compilation.emitAsset(o.fileName.replace(/\\/g, "/"), o.source);
        }
      }
    } catch (err) {
      const detail = (err && (err.message || err.toString())) || String(err);
      const more = err && Array.isArray(err.errors) ? err.errors.map((x) => x.message || String(x)).join(" | ") : "";
      compilation.errors.push({ message: `${e.name}: ${detail}${more ? " :: " + more : ""}` });
    } finally {
      if (bundle) { try { await bundle.close(); } catch (_) {} }
    }
  }
  compilation.__time = Date.now() - t0;
}

module.exports = { runMake, definePlugin, providePlugin, ignorePlugin, normalReplacePlugin };
