"use strict";
/* webpack `devtool` -> Rolldown output.sourcemap option. */
function devtoolToRolldown(devtool) {
  if (!devtool || devtool === "false" || devtool === false || devtool === "none") return { sourcemap: false, excludeSources: false };
  const d = String(devtool);
  let sourcemap = true;
  if (d.includes("inline")) sourcemap = "inline";
  else if (d.includes("hidden")) sourcemap = "hidden";
  // eval-* variants aren't supported by Rolldown; approximate with inline maps.
  else if (d.includes("eval")) sourcemap = "inline";
  return { sourcemap, excludeSources: d.includes("nosources") };
}
module.exports = { devtoolToRolldown };
