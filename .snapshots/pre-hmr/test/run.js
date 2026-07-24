"use strict";
/*
 * rollpack feature self-test. Builds synthetic projects that exercise the webpack surface and
 * asserts the results. Fast (no pcf), comprehensive. Run: node test/run.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const webpack = require("../lib/index.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
function section(s) { console.log("\n— " + s + " —"); }

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollpack-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
function run(config) { return new Promise((resolve) => webpack(config, (err, stats) => resolve({ err, stats }))); }
function read(dir, rel) { const p = path.join(dir, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; }

(async () => {
  section("core: TS, tree-shaking, minify, library(var)");
  {
    const dir = tmp({
      "src/used.ts": "export const USED = 'USED_VALUE'; export const UNUSED = 'UNUSED_VALUE';",
      "src/index.ts": "import { USED } from './used'; export const out = USED;",
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2018", module: "esnext" } }),
    });
    const { stats } = await run({ mode: "production", context: dir, entry: "./src/index.ts", output: { path: path.join(dir, "out"), filename: "b.js", library: "MyLib" }, stats: false });
    const code = read(dir, "out/b.js") || "";
    ok("builds + library global", /var MyLib\s*=/.test(code), code.slice(0, 80));
    ok("tree-shakes UNUSED", !code.includes("UNUSED_VALUE"));
    ok("keeps USED", code.includes("USED_VALUE"));
    ok("minified", code.split("\n").length < 5);
    ok("no errors", !stats.hasErrors());
  }

  section("multi-entry + nested library ['NS','[name]']");
  {
    const dir = tmp({ "a.ts": "export default 'AAA';", "b.ts": "export default 'BBB';" });
    const { stats } = await run({ mode: "production", context: dir, entry: { Alpha: "./a.ts", Beta: "./b.ts" }, output: { path: path.join(dir, "out"), filename: "[name].js", library: ["NS", "[name]"] }, stats: false });
    ok("emits Alpha.js", read(dir, "out/Alpha.js") != null);
    ok("emits Beta.js", read(dir, "out/Beta.js") != null);
    ok("nested NS.Alpha", /NS\.Alpha|NS\s*=\s*NS/.test(read(dir, "out/Alpha.js") || ""));
    ok("no errors", !stats.hasErrors());
  }

  section("DefinePlugin / EnvironmentPlugin / mode:none");
  {
    process.env.RP_TESTVAR = "envval";
    const dir = tmp({ "i.js": "export const v = __FEATURE__; export const e = process.env.RP_TESTVAR; export const n = process.env.NODE_ENV;" });
    const { stats } = await run({ mode: "none", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "b.js" }, plugins: [new webpack.DefinePlugin({ __FEATURE__: JSON.stringify("on") }), new webpack.EnvironmentPlugin(["RP_TESTVAR"])], stats: false });
    const code = read(dir, "out/b.js") || "";
    ok("DefinePlugin replaced __FEATURE__", code.includes('"on"') || code.includes("'on'"));
    ok("EnvironmentPlugin inlined env", code.includes("envval"));
    ok("mode:none not minified", code.split("\n").length > 3, "lines=" + code.split("\n").length);
    ok("no errors", !stats.hasErrors());
  }

  section("BannerPlugin (processAssets hook)");
  {
    const dir = tmp({ "i.js": "export const x = 1;" });
    await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "b.js" }, plugins: [new webpack.BannerPlugin({ banner: "RP_BANNER_TEXT", raw: false })], stats: false });
    const code = read(dir, "out/b.js") || "";
    ok("banner prepended", code.startsWith("/*! RP_BANNER_TEXT"));
  }

  section("custom plugin: hooks + emitAsset (Copy/Html-style)");
  {
    const dir = tmp({ "i.js": "export const x = 1;" });
    let sawDone = false;
    class MyPlugin {
      apply(compiler) {
        compiler.hooks.compilation.tap("MyPlugin", (compilation) => {
          compilation.hooks.processAssets.tap({ name: "MyPlugin", stage: 100 }, () => { compilation.emitAsset("extra.txt", "HELLO_FROM_PLUGIN"); });
        });
        compiler.hooks.done.tap("MyPlugin", () => { sawDone = true; });
      }
    }
    await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "b.js" }, plugins: [new MyPlugin()], stats: false });
    ok("plugin emitted extra asset", read(dir, "out/extra.txt") === "HELLO_FROM_PLUGIN");
    ok("compiler.hooks.done fired", sawDone);
  }

  section("loaders: custom loader + css");
  {
    const dir = tmp({
      "up.js": "module.exports = function(src){ return 'export default ' + JSON.stringify(String(src).toUpperCase()); };",
      "data.txt": "hello-loader",
      "styles.css": ".foo{color:red}",
      "i.js": "import t from './data.txt'; import './styles.css'; export const out = t;",
    });
    const { stats } = await run({
      mode: "production", context: dir, entry: "./i.js",
      output: { path: path.join(dir, "out"), filename: "b.js" },
      module: { rules: [{ test: /\.txt$/, use: [path.join(dir, "up.js")] }] },
      stats: false,
    });
    const code = read(dir, "out/b.js") || "";
    ok("custom loader ran (uppercased)", code.includes("HELLO-LOADER"));
    ok("css compiled+injected", code.includes("createElement") && code.includes("color:red"));
    ok("no errors", !stats.hasErrors(), JSON.stringify((stats.toJson().errors || []).map((e) => e.message)));
  }

  section("externals + MultiCompiler");
  {
    const dir = tmp({ "a.js": "import React from 'react'; export default React;", "b.js": "export default 2;" });
    const { stats } = await run([
      { mode: "production", context: dir, entry: "./a.js", output: { path: path.join(dir, "outA"), filename: "a.js", library: "A" }, externals: { react: "React" }, stats: false },
      { mode: "production", context: dir, entry: "./b.js", output: { path: path.join(dir, "outB"), filename: "b.js", library: "B" }, stats: false },
    ]);
    const a = read(dir, "outA/a.js") || "";
    ok("react externalized (not bundled)", /React/.test(a) && !/createElement/.test(a));
    ok("MultiCompiler built both", read(dir, "outA/a.js") != null && read(dir, "outB/b.js") != null);
    ok("MultiStats", typeof stats.hasErrors === "function" && Array.isArray(stats.stats));
  }

  section("devtool: source-map");
  {
    const dir = tmp({ "i.ts": "export const x = 1 + 2;" });
    await run({ mode: "production", context: dir, entry: "./i.ts", devtool: "source-map", output: { path: path.join(dir, "out"), filename: "b.js" }, stats: false });
    ok("emits .map", read(dir, "out/b.js.map") != null);
    ok("sourceMappingURL comment", (read(dir, "out/b.js") || "").includes("sourceMappingURL=b.js.map"));
  }

  section("output [contenthash] template");
  {
    const dir = tmp({ "i.js": "export const x = 12345;" });
    await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "app.[contenthash:8].js" }, stats: false });
    const files = fs.readdirSync(path.join(dir, "out"));
    ok("contenthash filename", files.some((f) => /^app\.[0-9a-f]{8}\.js$/.test(f)), files.join(","));
  }

  section("performance hints + ignoreWarnings");
  {
    const dir = tmp({ "i.js": "export const big = '" + "x".repeat(5000) + "';" });
    const { stats } = await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "b.js" }, performance: { hints: "warning", maxAssetSize: 100 }, stats: false });
    ok("performance warning emitted", stats.hasWarnings());
    const { stats: stats2 } = await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out2"), filename: "b.js" }, performance: { hints: "warning", maxAssetSize: 100 }, ignoreWarnings: [/exceeds the recommended/], stats: false });
    ok("ignoreWarnings filtered it", !stats2.hasWarnings());
  }

  section("code-splitting (dynamic import, es format)");
  {
    const dir = tmp({
      "lazy.js": "export const lazy = 'LAZY_CHUNK_VALUE';",
      "i.js": "export async function go(){ const m = await import('./lazy.js'); return m.lazy; }",
    });
    const { stats } = await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "main.js", library: { type: "module" }, chunkFilename: "[name].chunk.js" }, experiments: { outputModule: true }, stats: false });
    const files = fs.readdirSync(path.join(dir, "out"));
    ok("entry main.js emitted", files.includes("main.js"));
    ok("dynamic chunk split out", files.some((f) => /\.chunk\.js$/.test(f) || (f !== "main.js" && /\.js$/.test(f))), files.join(","));
    ok("no errors", !stats.hasErrors());
  }

  section("terserOptions honored (drop_console, mangle:false)");
  {
    const dir = tmp({ "i.js": "export function compute(){ console.log('DEBUG_LINE'); var keepThisName = Math.random(); for (var i = 0; i < 3; i++) keepThisName += Math.random(); return keepThisName; }" });
    await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "o1"), filename: "b.js", library: "X" }, optimization: { minimize: true, minimizer: [{ constructor: { name: "TerserPlugin" }, options: { terserOptions: { compress: { drop_console: true } } } }] }, stats: false });
    const c1 = read(dir, "o1/b.js") || "";
    ok("drop_console removed console.log", !c1.includes("DEBUG_LINE"));
    ok("default mangle renames local", !c1.includes("keepThisName"));
    await run({ mode: "production", context: dir, entry: "./i.js", output: { path: path.join(dir, "o2"), filename: "b.js", library: "X" }, optimization: { minimize: true, minimizer: [{ constructor: { name: "TerserPlugin" }, options: { terserOptions: { mangle: false } } }] }, stats: false });
    const c2 = read(dir, "o2/b.js") || "";
    ok("mangle:false keeps local name", c2.includes("keepThisName"));
  }

  section("dev server + HMR client + SSE live-reload");
  {
    const http = require("http");
    const httpGet = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ status: r.statusCode, body: d })); }).on("error", rej); });
    const dir = tmp({
      "index.html": "<!doctype html><html><head></head><body><div id=app></div><script src=/bundle.js></script></body></html>",
      "src/i.js": "if (module.hot) { module.hot.accept(); } export const v = 'V1';",
    });
    const compiler = webpack({ mode: "development", context: dir, entry: "./src/i.js", output: { path: path.join(dir, "out"), filename: "bundle.js" }, stats: false, devServer: { hot: true } });
    const server = new webpack.DevServer({ hot: true, port: 0, host: "127.0.0.1", static: dir }, compiler);
    await server.start();
    const port = server.server.address().port;
    const waitFor = (fn, ms) => new Promise((resolve) => { const t0 = Date.now(); const iv = setInterval(() => { if (fn() || Date.now() - t0 > ms) { clearInterval(iv); resolve(fn()); } }, 50); });

    const cl = await httpGet(`http://127.0.0.1:${port}/__rollpack_hmr_client.js`);
    ok("HMR client served", cl.body.includes("__rollpack_hot__"));
    const idx = await httpGet(`http://127.0.0.1:${port}/`);
    ok("index.html served + client injected", idx.body.includes("__rollpack_hmr_client.js"));
    await waitFor(() => (read(dir, "out/bundle.js") || "").length > 0, 5000);
    ok("module.hot wired in bundle (no ReferenceError)", (read(dir, "out/bundle.js") || "").includes("__rollpack_hot__"));

    const got = await new Promise((resolve) => {
      let done = false; let buf = "";
      const req = http.get(`http://127.0.0.1:${port}/__rollpack_sse`, (r) => {
        r.on("data", (c) => {
          buf += c; let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
            buf = buf.slice(i + 2);
            if (line) { try { const m = JSON.parse(line.slice(5).trim()); if (m.type === "ok" && !done) { done = true; resolve(true); } } catch (_) {} }
          }
        });
      });
      setTimeout(() => { try { fs.writeFileSync(path.join(dir, "src/i.js"), "if (module.hot) { module.hot.accept(); } export const v = 'V2';"); } catch (_) {} }, 500);
      setTimeout(() => { try { req.destroy(); } catch (_) {} if (!done) resolve(false); }, 5000);
    });
    ok("SSE pushed update on file change", got);
    await server.stop();
  }

  section("ProvidePlugin (real scope analysis)");
  {
    const dir = tmp({
      "free.js": "export const r = $('body').length;",                       // $ is free -> provided
      "bound.js": "function f(){ var $ = 5; return $; } export const r = f();", // $ is locally bound -> NOT provided
    });
    await run({ mode: "production", context: dir, entry: "./free.js", output: { path: path.join(dir, "o1"), filename: "b.js", library: "A" }, externals: { jquery: "jQuery" }, plugins: [new webpack.ProvidePlugin({ $: "jquery" })], stats: false });
    ok("free $ provided (references jQuery external)", (read(dir, "o1/b.js") || "").includes("jQuery"));
    await run({ mode: "production", context: dir, entry: "./bound.js", output: { path: path.join(dir, "o2"), filename: "b.js", library: "A" }, externals: { jquery: "jQuery" }, plugins: [new webpack.ProvidePlugin({ $: "jquery" })], stats: false });
    ok("locally-bound $ NOT provided", !(read(dir, "o2/b.js") || "").includes("jQuery"));
  }

  section("CSS Modules (scoped names + export map)");
  {
    const dir = tmp({
      "s.module.css": ".title { color: blue; } .body { font-size: 12px; }",
      "i.js": "import s from './s.module.css'; export const cls = s.title;",
    });
    const { stats } = await run({ mode: "development", context: dir, entry: "./i.js", output: { path: path.join(dir, "out"), filename: "b.js", library: "A" }, stats: false });
    const code = read(dir, "out/b.js") || "";
    ok("class scoped (not raw 'title')", /title___|__title/.test(code), code.slice(0, 200));
    ok("scoped css injected", code.includes("createElement") && code.includes("color:blue") || code.includes("color: blue"));
    ok("no errors", !stats.hasErrors());
  }

  section("devtool eval-source-map -> inline map");
  {
    const dir = tmp({ "i.ts": "export const x = 1 + 2;" });
    await run({ mode: "production", context: dir, entry: "./i.ts", devtool: "eval-source-map", output: { path: path.join(dir, "out"), filename: "b.js" }, stats: false });
    const code = read(dir, "out/b.js") || "";
    ok("inline source map present", code.includes("sourceMappingURL=data:application/json"));
  }

  section("webpack.* namespace");
  {
    ok("webpack.sources.RawSource", !!(webpack.sources && webpack.sources.RawSource));
    ok("webpack.Compiler/Compilation", !!webpack.Compiler && !!webpack.Compilation);
    ok("webpack.optimize.*", !!webpack.optimize.LimitChunkCountPlugin && !!webpack.optimize.SplitChunksPlugin);
    ok("webpack.container.ModuleFederationPlugin", !!webpack.container.ModuleFederationPlugin);
    ok("webpack.util.createHash", typeof webpack.util.createHash("sha256").update === "function");
    ok("webpack.version", !!webpack.version);
  }

  console.log(`\nrollpack self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
