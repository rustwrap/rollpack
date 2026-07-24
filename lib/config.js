"use strict";
/* Shared webpack-config translation helpers (entry, output/library, externals, resolve, define). */
const path = require("path");
const fs = require("fs");

function normalizeEntries(cfg, context) {
  const entry = cfg.entry;
  const out = cfg.output || {};
  const format = libraryFormat(out);
  const nested = (name) => (format === "iife" || format === "umd") ? !!(name && name.includes(".")) : false;
  const resolveInput = (imp) => {
    const v = Array.isArray(imp) ? imp[imp.length - 1] : imp;
    return path.isAbsolute(v) ? v : path.resolve(context, v);
  };
  if (!entry || typeof entry === "string" || Array.isArray(entry)) {
    const ln = libraryName(out.library, "main");
    return [{ name: "main", input: resolveInput(entry || "./src/index.js"), filename: out.filename || "main.js", libraryName: ln, format, extend: nested(ln) }];
  }
  const list = [];
  for (const [name, v] of Object.entries(entry)) {
    let imp = v, filename;
    if (v && typeof v === "object" && !Array.isArray(v)) { imp = Array.isArray(v.import) ? v.import[v.import.length - 1] : v.import; filename = v.filename; }
    const ln = libraryName(out.library, name);
    list.push({ name, input: resolveInput(imp), filename: (filename || out.filename || `${name}.js`).replace(/\[name\]/g, name), libraryName: ln, format, extend: nested(ln) });
  }
  return list;
}

function libraryFormat(out) {
  const lib = out.library;
  const type = out.libraryTarget || (lib && !Array.isArray(lib) && typeof lib === "object" && lib.type);
  switch (type) {
    case "commonjs": case "commonjs2": case "commonjs-module": return "cjs";
    case "module": return "es";
    case "umd": case "umd2": return "umd";
    case "amd": case "amd-require": return "amd";
    case "global": case "var": case "window": case "self": case "assign": case "this": default: return lib ? "iife" : "iife";
  }
}

function libraryName(lib, entryName) {
  if (!lib) return undefined;
  if (Array.isArray(lib)) return lib.map((s) => String(s).replace(/\[name\]/g, entryName)).join(".");
  if (typeof lib === "string") return lib.replace(/\[name\]/g, entryName);
  if (lib && lib.name) return (Array.isArray(lib.name) ? lib.name.join(".") : String(lib.name)).replace(/\[name\]/g, entryName);
  return undefined;
}

function findTsconfig(dir) {
  for (let i = 0; i < 10 && dir; i++) {
    const f = path.join(dir, "tsconfig.json");
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function buildResolve(cfg, context) {
  const r = cfg.resolve || {};
  const resolve = {};
  if (r.alias) { resolve.alias = {}; for (const [k, v] of Object.entries(r.alias)) resolve.alias[k] = v === false ? [require.resolve("./empty-module.js")] : (Array.isArray(v) ? v : [v]); }
  if (r.extensions && r.extensions.length) resolve.extensions = r.extensions;
  if (r.mainFields) resolve.mainFields = r.mainFields;
  if (r.mainFiles) resolve.mainFiles = r.mainFiles;
  if (r.conditionNames) resolve.conditionNames = r.conditionNames;
  if (r.modules) resolve.modules = r.modules;
  if (r.symlinks === false) resolve.symlinks = false;
  if (r.extensionAlias) resolve.extensionAlias = r.extensionAlias;
  // resolve.fallback: map `false` entries to an empty module, drop polyfill paths onto alias.
  if (r.fallback) {
    resolve.alias = resolve.alias || {};
    for (const [k, v] of Object.entries(r.fallback)) resolve.alias[k] = v === false ? [require.resolve("./empty-module.js")] : [v];
  }
  return resolve;
}

function stripGlobalPrefix(s) { return String(s).replace(/^(var|window|global|commonjs2?|this|self|umd|amd|module|node-commonjs|import|script|promise|system|jsonp)\s+/, ""); }
function sanitizeGlobal(id) { return String(id).replace(/[^a-zA-Z0-9_$]/g, "_"); }

function buildExternals(cfg, context) {
  const list = Array.isArray(cfg.externals) ? cfg.externals : cfg.externals ? [cfg.externals] : [];
  const map = {}; const regexes = []; const fns = [];
  for (const e of list) {
    if (!e) continue;
    if (e instanceof RegExp) regexes.push(e);
    else if (typeof e === "function") fns.push(e);
    else if (typeof e === "object") {
      for (const [k, v] of Object.entries(e)) {
        if (v instanceof RegExp) regexes.push(v);
        else if (typeof v === "string") map[k] = stripGlobalPrefix(v);
        else if (Array.isArray(v)) map[k] = stripGlobalPrefix(String(v[0]));
        else if (v === true) map[k] = k;
        else if (v && typeof v === "object" && v.root) map[k] = Array.isArray(v.root) ? v.root.join(".") : String(v.root);
      }
    }
  }
  const callFn = (request) => {
    for (const fn of fns) {
      let result;
      try {
        if (fn.length >= 3) fn({ request, context }, request, (_e, r) => { result = r; });
        else { const ret = fn({ request, context }, (_e, r) => { result = r; }); if (ret && typeof ret.then !== "function" && result === undefined) result = ret; }
      } catch (_) {}
      if (result) return typeof result === "string" ? stripGlobalPrefix(result) : (Array.isArray(result) ? result.join(".") : String(result));
    }
    return undefined;
  };
  const resolveGlobal = (id) => {
    // Webpack object externals match the EXACT request only (never subpaths). Matching subpaths
    // (e.g. `react/jsx-runtime` under a `react` external) wrongly maps the automatic JSX runtime to
    // the platform React global, which lacks jsx/jsxs -> "jsxs is not a function". Exact-match keeps
    // react/jsx-runtime (and other subpath entrypoints) bundled, exactly as webpack does.
    if (Object.prototype.hasOwnProperty.call(map, id)) return map[id];
    const f = callFn(id); if (f) return f;
    return undefined;
  };
  const isExternal = (id) => {
    if (id == null) return false;
    if (resolveGlobal(id) !== undefined) return true;
    for (const re of regexes) if (re.test(id)) return true;
    return false;
  };
  const globals = (id) => resolveGlobal(id) || sanitizeGlobal(id);
  return { isExternal, globals };
}

function buildDefine(cfg, prod, rustwrapDefine) {
  const def = Object.assign({ "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development") }, rustwrapDefine || {});
  return def;
}

module.exports = { normalizeEntries, libraryFormat, libraryName, findTsconfig, buildResolve, buildExternals, buildDefine, sanitizeGlobal, stripGlobalPrefix };
