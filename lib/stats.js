"use strict";
/* webpack-compatible Stats built from a Compilation's assets/errors/warnings. */

function createStats(compilation) {
  const errors = compilation.errors || [];
  const warnings = compilation.warnings || [];
  const time = compilation.__time || 0;
  const assetList = Object.keys(compilation.assets).map((name) => {
    const src = compilation.assets[name];
    const content = src.source();
    return { name, size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), "utf8"), info: compilation.assetsInfo.get(name) || {}, chunks: [], chunkNames: [], emitted: true };
  });
  const normErr = (e) => (e && typeof e === "object")
    ? { message: e.message || String(e), stack: e.stack, moduleName: e.moduleName, code: e.code }
    : { message: String(e) };

  const stats = {
    compilation,
    startTime: compilation.__startTime || 0,
    endTime: (compilation.__startTime || 0) + time,
    hasErrors: () => errors.length > 0,
    hasWarnings: () => warnings.length > 0,
    toJson(opts) {
      return {
        version: require("../package.json").version,
        rustwrap: true,
        hash: compilation.hash || "",
        time,
        builtAt: Date.now(),
        publicPath: (compilation.outputOptions && compilation.outputOptions.publicPath) || "",
        outputPath: compilation.compiler.outputPath,
        assetsByChunkName: {},
        assets: assetList,
        chunks: [],
        modules: [],
        entrypoints: {},
        namedChunkGroups: {},
        errors: errors.map(normErr),
        warnings: warnings.map(normErr),
        errorsCount: errors.length,
        warningsCount: warnings.length,
        children: [],
      };
    },
    toString(opts) {
      const useColors = opts && (opts === true || opts.colors);
      const C = useColors ? { d: "\x1b[2m", g: "\x1b[32m", c: "\x1b[36m", y: "\x1b[33m", r: "\x1b[0m" } : { d: "", g: "", c: "", y: "", r: "" };
      const lines = [];
      for (const e of errors) lines.push(`${C.y}ERROR${C.r} ` + (e.message || String(e)));
      for (const w of warnings) lines.push(`${C.y}WARNING${C.r} ` + (w.message || String(w)));
      const total = assetList.reduce((s, a) => s + a.size, 0);
      lines.push(`${C.c}@rustwrap/webpack${C.r} ${C.g}${assetList.length} assets${C.r} ${C.d}${fmt(total)} in ${time}ms${C.r}`);
      for (const a of assetList) lines.push(`  ${C.d}asset${C.r} ${C.c}${a.name}${C.r}  ${fmt(a.size)}`);
      return lines.join("\n");
    },
  };
  return stats;
}

function fmt(b) { return b > 1048576 ? (b / 1048576).toFixed(2) + " MiB" : (b / 1024).toFixed(1) + " KiB"; }

module.exports = { createStats };
