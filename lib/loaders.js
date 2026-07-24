"use strict";
/*
 * @rustwrap/webpack loader system — runs real webpack loader chains (module.rules) via loader-runner, so
 * css-loader/style-loader/sass-loader/@svgr/raw-loader/url-loader/file-loader/custom loaders work.
 *
 * JS/TS/JSX transpilation is left to Rolldown/Oxc (faster, equivalent output), so the well-known
 * transpile-only loaders (ts-loader, babel-loader, swc-loader, esbuild-loader) are filtered OUT of
 * chains; everything else runs. A file is processed by this system only when it has a non-empty
 * remaining loader chain.
 */
const path = require("path");
const fs = require("fs");
const { runLoaders } = require("loader-runner");

const SKIP_LOADERS = /[\\/](ts-loader|babel-loader|swc-loader|esbuild-loader|@swc[\\/]loader|style-loader|css-loader|sass-loader|less-loader|postcss-loader|mini-css-extract-plugin)[\\/]/i;
const JS_EXT = /\.(jsx?|mjs|cjs|tsx?|mts|cts)$/i;

// Flatten module.rules into pre/normal/post buckets, resolving `oneOf` and nested `rules`.
function flattenRules(rules, out) {
  for (const r of rules || []) {
    if (!r) continue;
    if (r.oneOf) { out._oneOf = out._oneOf || []; out._oneOf.push(r.oneOf); }
    flattenRule(r, out);
    if (r.rules) flattenRules(r.rules, out);
  }
  return out;
}
function flattenRule(r, out) {
  if (!r || (!r.test && !r.resource && !r.include && !r.exclude && !r.use && !r.loader && !r.resourceQuery)) return;
  const bucket = r.enforce === "pre" ? out.pre : r.enforce === "post" ? out.post : out.normal;
  bucket.push(r);
}

function ruleMatches(rule, resource, query) {
  const cond = (c, val) => {
    if (c == null) return undefined;
    if (c instanceof RegExp) return c.test(val);
    if (typeof c === "string") return val.startsWith(c) || val === c;
    if (typeof c === "function") return !!c(val);
    if (Array.isArray(c)) return c.some((x) => cond(x, val) === true);
    if (typeof c === "object") {
      if (c.and) return c.and.every((x) => cond(x, val) === true);
      if (c.or) return c.or.some((x) => cond(x, val) === true);
      if (c.not) return !cond(c.not, val);
      return undefined;
    }
    return undefined;
  };
  const test = rule.test !== undefined ? cond(rule.test, resource) : (rule.resource !== undefined ? cond(rule.resource, resource) : undefined);
  if (test === false) return false;
  if (rule.include !== undefined && cond(rule.include, resource) !== true) return false;
  if (rule.exclude !== undefined && cond(rule.exclude, resource) === true) return false;
  if (rule.resourceQuery !== undefined && cond(rule.resourceQuery, query || "") !== true) return false;
  // a rule with no positive resource condition but include/query still counts only if something matched
  if (test === undefined && rule.include === undefined && rule.resourceQuery === undefined) return false;
  return true;
}

// Normalize a rule's `use`/`loader` into [{loader, options, ident}], in declared order.
function ruleUse(rule) {
  let use = rule.use || rule.loader || rule.loaders;
  if (!use) return [];
  if (!Array.isArray(use)) use = [use];
  return use.map((u) => {
    if (typeof u === "string") return { loader: u, options: rule.options };
    if (typeof u === "function") return { loader: "__inline_fn__", fn: u };
    return { loader: u.loader, options: u.options, ident: u.ident };
  }).filter((u) => u.loader);
}

function resolveLoader(name, contexts) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  for (const base of contexts) {
    try { return require.resolve(name, { paths: [base] }); } catch (_) {}
    try { return require.resolve(name + "/package.json", { paths: [base] }).replace(/package\.json$/, "index.js"); } catch (_) {}
  }
  return null;
}

// Build the ordered loader list (post + normal + pre) for a resource, filtering transpile loaders.
function loadersFor(resource, query, buckets, contexts) {
  const collect = (bucketRules) => {
    const acc = [];
    for (const rule of bucketRules) {
      if (!ruleMatches(rule, resource, query)) continue;
      if (rule.type && /^asset/.test(rule.type)) { acc._assetType = rule.type; acc._parser = rule.parser; acc._generator = rule.generator; }
      for (const u of ruleUse(rule)) acc.push(u);
    }
    return acc;
  };
  // oneOf: first matching sub-rule wins
  let oneOfUse = [];
  let assetMeta = null;
  for (const group of buckets._oneOf || []) {
    for (const rule of group) {
      if (ruleMatches(rule, resource, query)) {
        if (rule.type && /^asset/.test(rule.type)) assetMeta = { type: rule.type, parser: rule.parser, generator: rule.generator };
        oneOfUse = ruleUse(rule);
        break;
      }
    }
    if (oneOfUse.length || assetMeta) break;
  }
  const normal = collect(buckets.normal).concat(oneOfUse);
  const pre = collect(buckets.pre);
  const post = collect(buckets.post);
  if (normal._assetType && !assetMeta) assetMeta = { type: normal._assetType, parser: normal._parser, generator: normal._generator };
  // webpack order for runLoaders: [post, normal, pre] (normal phase runs right->left, so pre first)
  let chain = post.concat(normal).concat(pre);
  // resolve + filter transpile-only loaders
  chain = chain
    .map((u) => {
      if (u.fn) return { loader: "inline", options: u.options, normal: u.fn, pitch: u.fn.pitch };
      const p = resolveLoader(u.loader, contexts);
      return p ? { loader: p, options: u.options, ident: u.ident } : null;
    })
    .filter((u) => u && !(typeof u.loader === "string" && SKIP_LOADERS.test(u.loader)));
  return { chain, assetMeta };
}

/*
 * A Rolldown plugin that applies module.rules. For any resolved module whose extension is non-JS or
 * which has a non-empty (non-transpile) loader chain, it runs the chain and returns the JS result.
 */
function loaderPlugin(cfg, context, compilation) {
  const buckets = flattenRules((cfg.module && cfg.module.rules) || [], { pre: [], normal: [], post: [] });
  const contexts = [context, process.cwd()];
  const prod = cfg.mode !== "development";
  const cssExtract = require("./css").cssExtractEnabled(cfg);
  const hasRules = buckets.pre.length || buckets.normal.length || buckets.post.length || (buckets._oneOf && buckets._oneOf.length);
  return {
    name: "rustwrap:loaders",
    async load(id) {
      const [resource, query] = id.split("?");
      // Native CSS pipeline, independent of configured css/style loaders.
      if (/\.(css|scss|sass|less)$/i.test(resource)) {
        return require("./css").handleCss(resource, cfg, compilation, prod, context, cssExtract);
      }
      if (!hasRules) return null;
      const { chain, assetMeta } = loadersFor(resource, query, buckets, contexts);
      const isJs = JS_EXT.test(resource);
      if (!chain.length && !assetMeta) {
        if (isJs) return null; // let Oxc handle JS/TS natively
        // Non-JS file with no configured loader: emit as an asset/resource (webpack-5-like default)
        // so the build doesn't choke parsing it as JS.
        return require("./assets").handleAsset(resource, { type: "asset/resource" }, cfg, compilation, prod);
      }
      // Asset module handling (type: asset/*) takes precedence when no JS-producing loaders remain.
      if (assetMeta && !chain.length) {
        return require("./assets").handleAsset(resource, assetMeta, cfg, compilation, prod);
      }
      if (!chain.length) return null;
      const source = fs.readFileSync(resource);
      const result = await runChain(chain, resource, source, cfg, context, compilation, prod);
      return result;
    },
  };
}

function runChain(chain, resource, source, cfg, context, compilation, prod) {
  return new Promise((resolve, reject) => {
    runLoaders({
      resource,
      loaders: chain,
      context: makeLoaderContext(cfg, context, compilation, prod, resource),
      readResource: (_p, cb) => cb(null, source),
    }, (err, res) => {
      if (err) return reject(err);
      let code = res.result && res.result[0];
      if (code == null) return resolve({ code: "export default undefined;", moduleType: "js" });
      if (Buffer.isBuffer(code)) code = code.toString("utf8");
      const map = res.result && res.result[1];
      resolve({ code: String(code), map: map && typeof map === "object" ? map : null, moduleType: "js" });
    });
  });
}

// A reasonable webpack NormalModule loaderContext.
function makeLoaderContext(cfg, context, compilation, prod, resource) {
  const dir = path.dirname(resource);
  return {
    rootContext: context,
    context: dir,
    resourcePath: resource,
    resourceQuery: "",
    mode: prod ? "production" : "development",
    sourceMap: !!cfg.devtool,
    target: cfg.target || "web",
    hot: !!(compilation && compilation.compiler && compilation.compiler.$rustwrap && compilation.compiler.$rustwrap.hot),
    webpack: true,
    _compiler: compilation && compilation.compiler,
    _compilation: compilation,
    _module: { type: "javascript/auto", resource },
    getOptions(schema) { return (this.__options) || {}; },
    emitWarning(w) { compilation && compilation.warnings.push({ message: String(w && w.message || w) }); },
    emitError(e) { compilation && compilation.errors.push({ message: String(e && e.message || e) }); },
    emitFile(name, content, map, assetInfo) { compilation && compilation.emitAsset(name, content, assetInfo); },
    addDependency() {}, dependency() {}, addContextDependency() {}, addMissingDependency() {}, clearDependencies() {},
    getLogger() { const noop = () => {}; return new Proxy({}, { get: () => noop }); },
    resolve(ctx, request, cb) { try { cb(null, require.resolve(request, { paths: [ctx] })); } catch (e) { cb(e); } },
    getResolve() { return (ctx, request, cb) => { try { const p = require.resolve(request, { paths: [ctx] }); return cb ? cb(null, p) : Promise.resolve(p); } catch (e) { return cb ? cb(e) : Promise.reject(e); } }; },
    utils: {
      absolutify: (ctxt, p) => path.resolve(ctxt, p),
      contextify: (ctxt, p) => path.relative(ctxt, p).replace(/\\/g, "/"),
      createHash: () => require("crypto").createHash("md4" in require("crypto").getHashes() ? "md4" : "sha256"),
    },
    fs,
  };
}

module.exports = { loaderPlugin, flattenRules, ruleMatches, loadersFor };
