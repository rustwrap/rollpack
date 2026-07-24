// Browser `process` shim (parity with webpack's process/browser). Covers what readable-stream and
// most Node-assuming libraries touch (nextTick, env, platform, versions, no-op event methods).
var process = {
  env: {},
  argv: [],
  browser: true,
  platform: "browser",
  arch: "browser",
  version: "",
  versions: {},
  title: "browser",
  nextTick: function (cb) {
    var args = [].slice.call(arguments, 1);
    var run = function () { cb.apply(null, args); };
    (typeof queueMicrotask !== "undefined" ? queueMicrotask : function (f) { setTimeout(f, 0); })(run);
  },
  cwd: function () { return "/"; },
  chdir: function () {},
  on: function () { return process; },
  once: function () { return process; },
  off: function () { return process; },
  addListener: function () { return process; },
  removeListener: function () { return process; },
  removeAllListeners: function () { return process; },
  emit: function () { return false; },
  prependListener: function () { return process; },
  listeners: function () { return []; },
  binding: function () { throw new Error("process.binding is not supported in the browser"); },
  umask: function () { return 0; },
};
export default process;
