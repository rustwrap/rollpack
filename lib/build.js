"use strict";
/*
 * build.js — the Rolldown "make" phase. Produces each entry's bundle and writes the result into
 * compilation.assets (the Compiler emits them later, after plugins' processAssets hooks). Integrates
 * the loader system, asset modules, Define/Provide/Ignore/NormalModuleReplacement, source maps,
 * target/platform, externals and library output formats.
 */
const path = require("path");
const fs = require("fs");
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
  const acorn = require("acorn");
  const tt = acorn.tokTypes;
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\w$.])(${escaped.join("|")})(?![\\w$])`, "g");
  const replaceAll = (code) => code.replace(re, (m) => (define[m] != null ? define[m] : m));
  return {
    name: "rustwrap:define",
    transform(code, id) {
      if (/[/\\]node_modules[/\\]/.test(id) && !/process\.env|typeof process|__DEV__/.test(code)) return null;
      re.lastIndex = 0;
      if (!re.test(code)) return null;
      // Collect ranges of string/template/regex literals and comments. webpack's DefinePlugin
      // replaces expressions only — never the contents of strings or comments — so we must skip
      // any match landing inside these ranges (a raw text replace would corrupt string literals).
      const protectedRanges = [];
      try {
        acorn.parse(code, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
          allowHashBang: true,
          onComment: (_block, _text, start, end) => protectedRanges.push([start, end]),
          onToken: (t) => {
            // `template` tokens are the literal chunks between `${}` — protecting them leaves the
            // interpolated `${expr}` code (separate tokens) eligible for replacement, like webpack.
            if (t.type === tt.string || t.type === tt.template || t.type === tt.regexp) protectedRanges.push([t.start, t.end]);
          },
        });
      } catch (_) {
        // Unparseable (already-CJS/odd syntax) — fall back to the identifier-boundary regex rather
        // than break the build. This preserves prior behavior for the rare unparseable module.
        re.lastIndex = 0;
        return { code: replaceAll(code), map: null };
      }
      const inProtected = (idx) => protectedRanges.some(([s, e]) => idx >= s && idx < e);
      re.lastIndex = 0;
      const out = code.replace(re, (m, _g1, offset) => (inProtected(offset) ? m : (define[m] != null ? define[m] : m)));
      return { code: out, map: null };
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
    name: "rustwrap:provide",
    transform(code, id) {
      if (/\.(css|scss|sass|less|svg)$/.test(id) || !simple.length) return null;
      if (!simple.some(([k]) => code.includes(k))) return null;
      let ast;
      try {
        ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", ranges: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
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

// Bundled CommonJS modules can `require("<external>")` (e.g. React's CJS `react/jsx-runtime` does
// `require("react")`). rolldown maps externals to globals for ESM imports via output.globals, but it
// does NOT rewrite a CJS module's internal `require(external)` -> the global, leaving a bare
// `require(...)` that throws "require is not defined" in the browser. This transform rewrites
// `require("<external>")` to the same platform/global the external resolves to, restoring webpack's
// behavior (where externals are reachable from both `import` and `require`).
function externalRequirePlugin(isExternal, globals) {
  if (typeof isExternal !== "function") return null;
  const RE = /(?<![\w.$])require\(\s*(['"])([^'"]+)\1\s*\)/g;
  return {
    name: "rustwrap:external-require",
    transform(code) {
      if (code.indexOf("require(") === -1) return null;
      let changed = false;
      const out = code.replace(RE, (m, _q, dep) => {
        let ext;
        try { ext = isExternal(dep); } catch { ext = false; }
        if (!ext) return m;
        let g;
        try { g = globals(dep); } catch { g = undefined; }
        if (!g || !/^[A-Za-z_$][\w$]*$/.test(g)) return m; // only simple global identifiers
        changed = true;
        // Reference the platform-provided global (same one output.globals binds for ESM imports);
        // fall back to globalThis lookup if the bare binding isn't in scope.
        return `(typeof ${g}!=="undefined"?${g}:(typeof globalThis!=="undefined"?globalThis:window)[${JSON.stringify(g)}])`;
      });
      return changed ? { code: out, map: null } : null;
    },
  };
}

// Node-builtin globals polyfill for browser targets (parity with webpack's ProvidePlugin +
// node-libs-browser, and pcf-scripts' esbuild `pcfEsbuildNodePolyfills`). Rolldown/webpack-5 do not
// auto-provide these, so a dependency that assumes Node (e.g. telemetry SDKs pulling in
// readable-stream/buffer) can reference a bare `process.nextTick`/`Buffer` that throws in the
// browser. Using the same free-variable scope analysis as ProvidePlugin, we inject `process`
// (inline shim), `global` (globalThis), and `Buffer` (the `buffer` package) ONLY into modules that
// reference them as free (unbound) identifiers — so it's a no-op for code that doesn't need them.
function nodePolyfillPlugin(platform) {
  if (platform === "node") return null; // node target: real builtins, no shim
  const acorn = require("acorn");
  const eslintScope = require("eslint-scope");
  const resolveSafe = (id) => { try { return require.resolve(id); } catch { return null; } };
  const bufferPath = resolveSafe("buffer/");
  const processPath = path.join(__dirname, "shims", "process.js");
  const globalPath = path.join(__dirname, "shims", "global.js");
  const SHIM_PATHS = new Set([processPath, globalPath, bufferPath].filter(Boolean));
  return {
    name: "rustwrap:node-polyfill",
    transform(code, id) {
      if (SHIM_PATHS.has(path.normalize(id))) return null; // never inject into the shims themselves
      // Skip rolldown's internal runtime/virtual modules — their interop helpers reference `Buffer`
      // in `typeof` guards, which would otherwise pull the whole buffer polyfill into every bundle.
      if (id.startsWith("\0") || /(?:^|[/\\])rolldown[/\\]|rolldown:/.test(id)) return null;
      if (/\.(css|scss|sass|less|svg)$/.test(id)) return null;
      if (!/(?<![\w.$])(process|Buffer|global)\b/.test(code)) return null;
      let ast;
      try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", ranges: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true }); }
      catch { return null; }
      let mgr;
      try { mgr = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module", ignoreEval: true, optimistic: true }); }
      catch { return null; }
      const free = new Set(mgr.globalScope.through.map((r) => r.identifier.name));
      let header = "";
      if (free.has("process")) header += `import __rp_process from ${JSON.stringify(processPath)};\nvar process=__rp_process;\n`;
      if (free.has("global")) header += `import __rp_global from ${JSON.stringify(globalPath)};\nvar global=__rp_global;\n`;
      if (free.has("Buffer") && bufferPath) header += `import { Buffer as __rp_Buffer } from ${JSON.stringify(bufferPath)};\nvar Buffer=__rp_Buffer;\n`;
      return header ? { code: header + code, map: null } : null;
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
  const VID = "\0rustwrap-ignored";
  return {
    name: "rustwrap:ignore",
    resolveId(source, importer) { if (matches(source, importer && path.dirname(importer))) return VID; return null; },
    load(id) { if (id === VID) return "export default {};"; return null; },
  };
}

function normalReplacePlugin(replacements) {
  if (!replacements || !replacements.length) return null;
  return {
    name: "rustwrap:normal-replace",
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

// Tier 2 (webpack-parity resolution). rolldown can fail to statically resolve a named re-export that
// is only reachable through a transitive `export * from './x'` — e.g. @griffel/react's
// `export { RESET } from '@griffel/core'`, where core exposes RESET only via
// `export * from './constants.js'`. In large graphs the star target isn't always analyzed in time, so
// rolldown reports MISSING_EXPORT (where webpack resolves it fine). We match webpack by making the
// star explicit: for each bare `export * from './x'` we append `export { a, b, ... } from './x'` with
// the target's real named exports, so every name is statically visible. Stays 100% ESM (unlike a CJS
// redirect, which broke on module-system mixing), so the REAL export value is bundled — no shim.
// Anything we can't parse falls back to Tier 1 (shimMissingExports).
function destarReexportPlugin() {
  const acorn = require("acorn");
  const namesCache = new Map();
  const parse = (code) => { try { return acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", ranges: true, allowHashBang: true, allowReturnOutsideFunction: true }); } catch { return null; } };
  const collectDeclNames = (decl, out) => {
    if (!decl) return;
    if (decl.type === "VariableDeclaration") { for (const d of decl.declarations) collectPattern(d.id, out); }
    else if (decl.id && decl.id.name) out.add(decl.id.name);
  };
  const collectPattern = (node, out) => {
    if (!node) return;
    if (node.type === "Identifier") out.add(node.name);
    else if (node.type === "ObjectPattern") for (const p of node.properties) collectPattern(p.value || p.argument, out);
    else if (node.type === "ArrayPattern") for (const el of node.elements) el && collectPattern(el, out);
    else if (node.type === "AssignmentPattern") collectPattern(node.left, out);
    else if (node.type === "RestElement") collectPattern(node.argument, out);
  };
  // All named exports of a module (recursing into its own bare `export *`), excluding `default`.
  async function namedExportsOf(ctx, resolvedId, seen) {
    if (seen.has(resolvedId)) return [];
    seen.add(resolvedId);
    if (namesCache.has(resolvedId)) return namesCache.get(resolvedId);
    let code;
    try { code = fs.readFileSync(resolvedId, "utf8"); } catch { return []; }
    const ast = parse(code);
    if (!ast) { namesCache.set(resolvedId, []); return []; }
    const names = new Set();
    for (const node of ast.body) {
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration) collectDeclNames(node.declaration, names);
        for (const spec of node.specifiers || []) if (spec.exported && spec.exported.name) names.add(spec.exported.name);
      } else if (node.type === "ExportAllDeclaration") {
        if (node.exported) names.add(node.exported.name);
        else {
          let r; try { r = await ctx.resolve(node.source.value, resolvedId, { skipSelf: true }); } catch { r = null; }
          if (r && r.id && !r.id.startsWith("\0") && !r.external) for (const n of await namedExportsOf(ctx, r.id, seen)) names.add(n);
        }
      }
    }
    names.delete("default");
    const arr = [...names];
    namesCache.set(resolvedId, arr);
    return arr;
  }
  return {
    name: "rustwrap:destar-reexport",
    async transform(code, id) {
      if (!id || id[0] === "\0" || !/export\s*\*\s*from/.test(code)) return null;
      const ast = parse(code);
      if (!ast) return null;
      const stars = ast.body.filter((n) => n.type === "ExportAllDeclaration" && !n.exported);
      if (!stars.length) return null;
      // Names this module already exports (explicit decls / named re-exports / `export * as ns` /
      // default) — a bare `export *` omits these, and re-declaring them would be a duplicate export.
      const claimed = new Set();
      for (const node of ast.body) {
        if (node.type === "ExportNamedDeclaration") {
          if (node.declaration) collectDeclNames(node.declaration, claimed);
          for (const spec of node.specifiers || []) if (spec.exported && spec.exported.name) claimed.add(spec.exported.name);
        } else if (node.type === "ExportAllDeclaration" && node.exported) claimed.add(node.exported.name);
        else if (node.type === "ExportDefaultDeclaration") claimed.add("default");
      }
      let appended = "";
      for (const node of stars) {
        let resolved; try { resolved = await this.resolve(node.source.value, id, { skipSelf: true }); } catch { resolved = null; }
        if (!resolved || !resolved.id || resolved.id.startsWith("\0") || resolved.external) continue;
        const names = (await namedExportsOf(this, resolved.id, new Set())).filter((n) => !claimed.has(n));
        names.forEach((n) => claimed.add(n));
        if (names.length) appended += `\nexport { ${names.join(", ")} } from ${JSON.stringify(node.source.value)};`;
      }
      return appended ? { code: code + appended, map: null } : null;
    },
  };
}

function entryRel(e, chunkFileName) {
  const rel = (e.filename || chunkFileName).replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  return rel;
}

// Rollup/rolldown bundle-format advisories that are artifacts of how rollpack drives rolldown (not
// user-actionable) — suppressed from Tier 3 warning surfacing to match webpack's quieter output.
const BENIGN_ROLLDOWN_WARNINGS = new Set([
  "MISSING_NAME_OPTION_FOR_IIFE_EXPORT", "MISSING_GLOBAL_NAME", "MIXED_EXPORTS", "EMPTY_BUNDLE",
  "PREFER_NAMED_EXPORTS", "THIS_IS_UNDEFINED", "CIRCULAR_DEPENDENCY", "EVAL", "MODULE_LEVEL_DIRECTIVE",
  "UNUSED_EXTERNAL_IMPORT", "INVALID_ANNOTATION",
]);

function collectDefines(cfg, context, compilation, nativeHmr) {
  const compiler = compilation.compiler;
  const rp = compiler.$rustwrap || {};
  const prod = cfg.mode !== "development" && cfg.mode !== "none";
  const define = buildDefine(cfg, prod, rp.define);
  // Inline ambient `const enum` member accesses to literals (tsc parity). Without this, oxc/rolldown
  // leave e.g. `XrmClientApi.Constants.GlobalNotificationLevel.success` as a runtime reference to a
  // namespace that doesn't exist at runtime -> "XrmClientApi is not defined". We feed the collected
  // `Ns.Enum.Member` -> literal map through the same Define replacement. Explicit user defines win.
  try {
    const { collectConstEnumDefines } = require("./const-enum");
    const ce = collectConstEnumDefines(context);
    for (const k of Object.keys(ce)) if (define[k] == null) define[k] = ce[k];
  } catch { /* typescript unavailable or parse failure -> skip inlining (non-fatal) */ }
  // When hot is enabled (dev server or HotModuleReplacementPlugin), make `module.hot` /
  // `import.meta.hot` resolve to the injected client runtime so HMR-guarded code runs.
  if (rp.hot) {
    if (nativeHmr) {
      // DevEngine gives every module its own import.meta.hot context. Mapping webpack's spelling
      // onto that expression preserves module identity, acceptance boundaries and dispose data.
      define["module.hot"] = "import.meta.hot";
      define["import.meta.webpackHot"] = "import.meta.hot";
      define["typeof module"] = JSON.stringify("object");
    } else {
      define["module.hot"] = "(typeof window!=='undefined'&&window.__rustwrap_hot__)";
      define["import.meta.hot"] = "(typeof window!=='undefined'&&window.__rustwrap_hot__)";
      define["import.meta.webpackHot"] = "(typeof window!=='undefined'&&window.__rustwrap_hot__)";
    }
  }
  return define;
}

function createBuildPlan(compilation, cfg, context, options) {
  const opts = options || {};
  const compiler = compilation.compiler;
  const rp = compiler.$rustwrap || {};
  const prod = cfg.mode !== "development" && cfg.mode !== "none";
  const minimize = readMinimize(cfg);
  const entries = normalizeEntries(cfg, context);
  const ext = buildExternals(cfg, context);
  const define = collectDefines(cfg, context, compilation, !!opts.nativeHmr);
  const resolve = buildResolve(cfg, context);
  const { sourcemap } = devtoolToRolldown(cfg.devtool);
  const platform = targetPlatform(cfg.target);
  const moduleTypes = nonJsModuleTypes();
  const minifyOpt = buildMinify(cfg, minimize);
  const plugins = [
    ignorePlugin(rp.ignore),
    normalReplacePlugin(rp.normalReplace),
    destarReexportPlugin(),
    loaderPlugin(cfg, context, compilation),
    providePlugin(rp.provide, context),
    definePlugin(define),
    externalRequirePlugin(ext.isExternal, ext.globals),
    nodePolyfillPlugin(platform),
  ].filter(Boolean);

  const inputOptions = (entry) => {
    const input = {
      cwd: context,
      input: entry.input,
      external: ext.isExternal,
      platform,
      treeshake: cfg.optimization && cfg.optimization.usedExports === false ? false : true,
      resolve,
      moduleTypes,
      plugins,
      // Tier 1 (safety net / fallback). Tier 2 (the de-star transform) resolves most transitive
      // `export *` re-exports to their real value. This is the fallback for anything still
      // unresolvable (e.g. a genuinely-dropped export after version drift, or a source we can't
      // parse): shim it to undefined and continue, exactly like webpack — never a hard failure.
      shimMissingExports: true,
      // Tier 3 (visibility). Don't swallow rolldown diagnostics — surface meaningful warnings into
      // `compilation.warnings` as webpack-style messages (e.g. a shimmed/undefined export), so real
      // problems stay visible and filterable. Benign bundle-format advisories (which are artifacts of
      // how we drive rolldown, not user-actionable) are suppressed to match webpack's quiet output.
      onLog: (level, log) => {
        try {
          if (level !== "warn") return;
          const code = (log && log.code) || "";
          if (BENIGN_ROLLDOWN_WARNINGS.has(code)) return;
          const msg = (log && (log.message || log.text)) || String(log || "");
          compilation.warnings.push({ name: "RolldownWarning", code, message: `[@rustwrap/webpack]${code ? " " + code : ""}: ${msg}`.trim() });
        } catch (_) { /* logging must never break the build */ }
      },
    };
    if (opts.devMode) input.experimental = { devMode: opts.devMode };
    return input;
  };

  const outputOptions = (entry) => {
    const codeSplitting = (entry.format === "es" || entry.format === "cjs")
      && !singleChunkForced(cfg) && entries.length === 1;
    return {
      format: entry.format,
      name: entry.libraryName || undefined,
      extend: entry.extend,
      globals: ext.globals,
      minify: minifyOpt,
      codeSplitting,
      chunkFileNames: convertChunkTemplate((cfg.output && cfg.output.chunkFilename) || "[name].js"),
      sourcemap,
    };
  };

  return { entries, inputOptions, outputOptions, sourcemap, platform };
}

function emitRolldownOutput(compilation, entry, generated, sourcemap) {
  const output = generated && generated.output ? generated.output : [];
  for (const item of output) {
    if (item.type === "chunk") {
      let code = item.code != null ? item.code : "";
      const rel0 = item.isEntry ? entryRel(entry, item.fileName) : item.fileName.replace(/\\/g, "/");
      const rel = require("./template").interpolateName(rel0, {
        name: item.isEntry ? entry.name : path.basename(rel0, path.extname(rel0)),
        chunkName: entry.name,
        id: entry.name,
        content: code,
        ext: path.extname(rel0) || ".js",
      });
      if (item.map && sourcemap && sourcemap !== "inline") {
        const mapName = rel + ".map";
        compilation.emitAsset(mapName, typeof item.map === "string" ? item.map : JSON.stringify(item.map));
        if (sourcemap !== "hidden") code += `\n//# sourceMappingURL=${path.posix.basename(mapName)}`;
      }
      compilation.emitAsset(rel, code);
    } else {
      // Rolldown also emits the sourcemap as a separate asset named after the chunk's default
      // fileName; the map above is renamed to match the webpack entry filename.
      if (/\.map$/.test(item.fileName)) continue;
      compilation.emitAsset(item.fileName.replace(/\\/g, "/"), item.source);
    }
  }
}

function addBuildError(compilation, entryName, err) {
  const detail = (err && (err.message || err.toString())) || String(err);
  const nested = err && Array.isArray(err.errors) ? err.errors : [];
  const more = nested.map((item) => item.message || String(item)).join(" | ");
  const code = (err && err.code) || (nested[0] && nested[0].code);
  compilation.errors.push({
    name: "RolldownError",
    code,
    cause: err,
    message: `${entryName}: ${detail}${more ? " :: " + more : ""}`,
  });
}

function mergeBuildSink(compilation, snapshot) {
  if (!snapshot) return;
  for (const asset of snapshot.assets || []) compilation.emitAsset(asset.name, asset.source, asset.info);
  compilation.errors.push(...(snapshot.errors || []));
  compilation.warnings.push(...(snapshot.warnings || []));
}

function createBuildSink(compiler) {
  const sink = {
    compiler,
    options: compiler.options,
    outputOptions: compiler.options.output || {},
    assets: {},
    assetsInfo: new Map(),
    errors: [],
    warnings: [],
    emitAsset(name, source, info) {
      name = name.replace(/\\/g, "/");
      this.assets[name] = source;
      if (info) this.assetsInfo.set(name, info);
    },
    updateAsset(name, sourceOrFn, info) {
      name = name.replace(/\\/g, "/");
      const current = this.assets[name];
      this.assets[name] = typeof sourceOrFn === "function" ? sourceOrFn(current) : sourceOrFn;
      if (info) this.assetsInfo.set(name, info);
    },
    getAsset(name) {
      name = name.replace(/\\/g, "/");
      return Object.prototype.hasOwnProperty.call(this.assets, name)
        ? { name, source: this.assets[name], info: this.assetsInfo.get(name) || {} }
        : undefined;
    },
    deleteAsset(name) {
      name = name.replace(/\\/g, "/");
      delete this.assets[name];
      this.assetsInfo.delete(name);
    },
    getLogger() {
      const noop = () => {};
      return new Proxy({}, { get: () => noop });
    },
    drain() {
      const assets = Object.keys(this.assets).map((name) => ({
        name,
        source: this.assets[name],
        info: this.assetsInfo.get(name) || {},
      }));
      for (const name of Object.keys(this.assets)) delete this.assets[name];
      this.assetsInfo.clear();
      return {
        assets,
        errors: this.errors.splice(0),
        warnings: this.warnings.splice(0),
      };
    },
  };
  return sink;
}

function createNativeDevBuild(compiler, cfg, context, devMode) {
  const sink = createBuildSink(compiler);
  const plan = createBuildPlan(sink, cfg, context, { nativeHmr: true, devMode });
  if (plan.entries.length !== 1 || plan.platform !== "browser") return null;
  const entry = plan.entries[0];
  return {
    sink,
    entry,
    inputOptions: plan.inputOptions(entry),
    outputOptions: Object.assign({ dir: compiler.outputPath }, plan.outputOptions(entry)),
  };
}

async function runMake(compilation, cfg, context) {
  const prebuilt = compilation.__rustwrapPrebuilt;
  const plan = createBuildPlan(compilation, cfg, context, { nativeHmr: !!(prebuilt && prebuilt.nativeHmr) });
  const t0 = Date.now();
  compilation.__startTime = t0;

  if (prebuilt) {
    mergeBuildSink(compilation, prebuilt.sink);
    if (prebuilt.error) addBuildError(compilation, plan.entries[0] ? plan.entries[0].name : "main", prebuilt.error);
    else if (plan.entries[0]) emitRolldownOutput(compilation, plan.entries[0], prebuilt.output, plan.sourcemap);
    compilation.__time = Date.now() - t0;
    return;
  }

  for (const entry of plan.entries) {
    let bundle;
    try {
      bundle = await rolldown(plan.inputOptions(entry));
      const generated = await bundle.generate(plan.outputOptions(entry));
      emitRolldownOutput(compilation, entry, generated, plan.sourcemap);
    } catch (err) {
      addBuildError(compilation, entry.name, err);
    } finally {
      if (bundle) { try { await bundle.close(); } catch (_) {} }
    }
  }
  compilation.__time = Date.now() - t0;
}

module.exports = {
  runMake,
  createNativeDevBuild,
  definePlugin,
  providePlugin,
  ignorePlugin,
  normalReplacePlugin,
};
