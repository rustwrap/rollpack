"use strict";
/*
 * Native CSS pipeline (webpack's css-loader/style-loader emit webpack-runtime-coupled output that a
 * non-webpack bundler can't consume, so rollpack handles CSS itself, Vite-style):
 *   - .scss/.sass -> compiled with the consumer's `sass` (or node-sass) if available.
 *   - .less       -> compiled with the consumer's `less` if available.
 *   - .css        -> used as-is.
 * Then either injected at runtime via a <style> tag (style-loader behavior) or, when
 * MiniCssExtractPlugin is in use, emitted as a .css asset.
 *
 * CSS Modules (*.module.css) get a best-effort local-class identity map (className -> className).
 */
const path = require("path");
const fs = require("fs");

function resolveFrom(name, dirs) {
  for (const d of dirs) { try { return require(require.resolve(name, { paths: [d] })); } catch (_) {} }
  return null;
}

function compile(resource, context, compilation) {
  const ext = path.extname(resource).toLowerCase();
  const dirs = [path.dirname(resource), context, process.cwd()];
  try {
    if (ext === ".scss" || ext === ".sass") {
      const sass = resolveFrom("sass", dirs);
      if (sass && sass.compile) return sass.compile(resource, { style: "compressed", loadPaths: [path.dirname(resource)] }).css;
      const nodeSass = resolveFrom("node-sass", dirs);
      if (nodeSass && nodeSass.renderSync) return nodeSass.renderSync({ file: resource, outputStyle: "compressed" }).css.toString();
      compilation && compilation.warnings.push({ message: `rollpack: no 'sass' available to compile ${path.basename(resource)} — emitting empty CSS` });
      return "";
    }
    if (ext === ".less") {
      const less = resolveFrom("less", dirs);
      if (less && less.render) { let css = ""; less.render(fs.readFileSync(resource, "utf8"), { filename: resource, compress: true }, (e, o) => { if (!e && o) css = o.css; }); return css; }
      return "";
    }
    return fs.readFileSync(resource, "utf8");
  } catch (e) {
    compilation && compilation.errors.push({ message: `rollpack CSS (${path.basename(resource)}): ${e && e.message || e}` });
    return "";
  }
}

// Very small CSS-modules local map: collect class names so `styles.foo` resolves to "foo".
function moduleMap(css) {
  const names = new Set();
  const re = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g;
  let m;
  while ((m = re.exec(css))) names.add(m[1]);
  const obj = {};
  for (const n of names) obj[n] = n;
  return obj;
}

// Proper CSS Modules scoping via postcss + postcss-modules: rewrites local class names to scoped
// names and returns the { localName: scopedName } export map (composes supported).
async function runCssModules(css, resource, prod) {
  let postcss, postcssModules;
  try { postcss = require("postcss"); postcssModules = require("postcss-modules"); }
  catch (_) { return { css, tokens: moduleMap(css) }; } // fallback: identity map
  let tokens = {};
  const scoped = prod ? "[hash:base64:8]" : "[name]__[local]___[hash:base64:5]";
  try {
    const result = await postcss([
      postcssModules({ generateScopedName: scoped, getJSON: (_f, json) => { tokens = json; } }),
    ]).process(css, { from: resource });
    return { css: result.css, tokens };
  } catch (e) {
    return { css, tokens: moduleMap(css) };
  }
}

async function handleCss(resource, cfg, compilation, prod, context, extract) {
  const isModule = /\.module\.(css|scss|sass|less)$/i.test(resource);
  let css = compile(resource, context, compilation) || "";
  let exportsObj = {};
  if (isModule && css) {
    const r = await runCssModules(css, resource, prod);
    css = r.css;
    exportsObj = r.tokens || {};
  }
  const exportDefault = `export default ${JSON.stringify(exportsObj)};` +
    Object.keys(exportsObj).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k)).map((k) => `\nexport var ${k} = ${JSON.stringify(exportsObj[k])};`).join("");

  if (extract) {
    const out = cfg.output || {};
    const base = path.basename(resource).replace(/\.(scss|sass|less)$/i, ".css");
    const name = (out.cssFilename || "[name].css").replace(/\[name\]/g, path.basename(base, ".css"));
    if (compilation) compilation.emitAsset(name.replace(/^\.?[\\/]/, ""), css);
    return { code: exportDefault, moduleType: "js" };
  }

  const inject = `(function(){if(typeof document==='undefined')return;var c=${JSON.stringify(css)};if(!c)return;var s=document.createElement('style');s.setAttribute('data-rollpack','');s.appendChild(document.createTextNode(c));document.head.appendChild(s);})();`;
  return { code: `${inject}\n${exportDefault}`, moduleType: "js" };
}

function cssExtractEnabled(cfg) {
  for (const p of cfg.plugins || []) if (p && p.constructor && p.constructor.name === "MiniCssExtractPlugin") return true;
  return false;
}

module.exports = { handleCss, cssExtractEnabled };
