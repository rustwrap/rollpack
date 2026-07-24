// Browser `global` shim (parity with webpack, which maps `global` -> the global object).
export default (typeof globalThis !== "undefined"
  ? globalThis
  : typeof self !== "undefined"
    ? self
    : typeof window !== "undefined"
      ? window
      : this);
