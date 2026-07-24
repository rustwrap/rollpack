"use strict";

function installNativeRuntime() {
  class RustwrapHotContext {
    constructor(moduleId, runtime) {
      this.moduleId = moduleId;
      this.runtime = runtime;
      this.active = true;
      this.data = runtime.hotData.get(moduleId);
      this._accepts = [];
      this._selfAccepted = null;
      this._selfDeclined = false;
      this._declined = new Set();
      this._disposeHandlers = [];
      this._invalidateHandlers = [];
    }

    accept(dependencies, callback, errorHandler) {
      if (dependencies == null || typeof dependencies === "function") {
        this._selfAccepted = {
          deps: [this.moduleId],
          callback: typeof dependencies === "function" ? dependencies : function () {},
          errorHandler,
        };
        return;
      }
      const deps = Array.isArray(dependencies) ? dependencies.slice() : [dependencies];
      this._accepts.push({
        deps,
        callback: typeof callback === "function" ? callback : function () {},
        errorHandler,
      });
    }

    acceptExports(_exports, callback) {
      this.accept(callback || function () {});
    }

    decline(dependencies) {
      if (dependencies == null) {
        this._selfDeclined = true;
        return;
      }
      for (const dep of Array.isArray(dependencies) ? dependencies : [dependencies]) {
        this._declined.add(dep);
      }
    }

    dispose(callback) {
      if (typeof callback === "function") this._disposeHandlers.push(callback);
    }

    addDisposeHandler(callback) {
      this.dispose(callback);
    }

    removeDisposeHandler(callback) {
      this._disposeHandlers = this._disposeHandlers.filter((handler) => handler !== callback);
    }

    addInvalidateHandler(callback) {
      if (typeof callback === "function") this._invalidateHandlers.push(callback);
    }

    removeInvalidateHandler(callback) {
      this._invalidateHandlers = this._invalidateHandlers.filter((handler) => handler !== callback);
    }

    invalidate() {
      for (const handler of this._invalidateHandlers.slice()) {
        try { handler(); } catch (error) { console.error(error); }
      }
      this.runtime.invalidate(this.moduleId);
    }

    status() {
      return this.runtime.status;
    }

    addStatusHandler(callback) {
      this.runtime.statusHandlers.add(callback);
    }

    removeStatusHandler(callback) {
      this.runtime.statusHandlers.delete(callback);
    }

    check() {
      return Promise.resolve(null);
    }

    apply() {
      return Promise.resolve(this.runtime.lastUpdated.slice());
    }

    _acceptsDependency(id) {
      return this._accepts.filter((record) => record.deps.includes(id));
    }
  }

  class RustwrapDevRuntime extends DevRuntime {
    constructor(clientId) {
      super(clientId);
      this.moduleHotContexts = new Map();
      this.hotData = new Map();
      this.status = "idle";
      this.statusHandlers = new Set();
      this.lastUpdated = [];
      this.invalidated = new Set();
      this.applying = false;
      this.eventSource = null;
      this.updateQueue = Promise.resolve();
      this.hooks = {
        createModuleHotContext: (id) => this._createModuleHotContext(id),
        onModuleCacheRemoval: (id) => this.moduleHotContexts.delete(id),
      };
    }

    createModuleHotContext(moduleId) {
      return this._createModuleHotContext(moduleId);
    }

    _createModuleHotContext(moduleId) {
      const context = new RustwrapHotContext(moduleId, this);
      this.moduleHotContexts.set(moduleId, context);
      return context;
    }

    setStatus(next) {
      this.status = next;
      for (const handler of this.statusHandlers) {
        try { handler(next); } catch (error) { console.error(error); }
      }
    }

    invalidate(moduleId) {
      if (this.applying) {
        this.invalidated.add(moduleId);
        return;
      }
      if (typeof location !== "undefined" && typeof location.reload === "function") {
        location.reload();
      }
    }

    applyUpdate(changedIds) {
      this.setStatus("check");
      const updated = new Set();
      let outcome = this._applyChanged(changedIds, updated);
      for (let pass = 0; !outcome.reload && this.invalidated.size && pass < 10; pass++) {
        const invalidated = [...this.invalidated];
        this.invalidated.clear();
        outcome = this._applyInvalidated(invalidated, updated);
      }
      if (!outcome.reload && this.invalidated.size) {
        outcome = { reload: true, reason: "too many chained HMR invalidations" };
      }
      this.lastUpdated = [...updated];
      this.setStatus(outcome.reload ? "abort" : "idle");
      return Object.assign({ updated: this.lastUpdated }, outcome);
    }

    _applyChanged(changedIds, updated) {
      const plan = this._newPlan();
      const traversed = new Set();
      for (const id of changedIds) {
        if (!this.isExecuted(id)) continue;
        const reason = this._walk(id, [id], plan, traversed, null);
        if (reason) return { reload: true, reason };
      }
      return this._executePlan(plan, updated);
    }

    _applyInvalidated(moduleIds, updated) {
      const plan = this._newPlan();
      const traversed = new Set();
      for (const id of moduleIds) {
        const parents = this.getImporters(id).filter((parent) => this.isExecuted(parent));
        if (!parents.length) return { reload: true, reason: `module \`${id}\` invalidated without an accepting parent` };
        for (const parent of parents) {
          const context = this.moduleHotContexts.get(parent);
          if (context && context._declined.has(id)) {
            return { reload: true, reason: `module \`${parent}\` declined \`${id}\`` };
          }
          const accepts = context ? context._acceptsDependency(id) : [];
          if (accepts.length) {
            plan.boundaries.push({ boundary: parent, acceptedVia: id, records: accepts });
            continue;
          }
          const reason = this._walk(parent, [id, parent], plan, traversed, null);
          if (reason) return { reload: true, reason };
        }
      }
      return this._executePlan(plan, updated);
    }

    _newPlan() {
      return { updateSet: new Set(), boundaries: [] };
    }

    _walk(id, chain, plan, traversed, skipSelf) {
      if (traversed.has(id)) return null;
      traversed.add(id);
      plan.updateSet.add(id);
      const context = this.moduleHotContexts.get(id);
      if (context && id !== skipSelf) {
        if (context._selfDeclined) return `module \`${id}\` declined its update`;
        if (context._selfAccepted) {
          plan.boundaries.push({ boundary: id, acceptedVia: id, records: [context._selfAccepted] });
          return null;
        }
      }
      const parents = this.getImporters(id).filter((parent) => this.isExecuted(parent));
      if (!parents.length) return `no HMR boundary accepts module \`${id}\``;
      for (const parent of parents) {
        const parentContext = this.moduleHotContexts.get(parent);
        if (parentContext && parentContext._declined.has(id)) {
          return `module \`${parent}\` declined \`${id}\``;
        }
        const accepts = parentContext ? parentContext._acceptsDependency(id) : [];
        if (accepts.length) {
          plan.boundaries.push({ boundary: parent, acceptedVia: id, records: accepts });
          continue;
        }
        if (chain.includes(parent)) return `circular import chain between \`${id}\` and \`${parent}\``;
        chain.push(parent);
        const reason = this._walk(parent, chain, plan, traversed, skipSelf);
        chain.pop();
        if (reason) return reason;
      }
      return null;
    }

    _executePlan(plan, updated) {
      for (const id of plan.updateSet) {
        if (!this.hasFactory(id)) return { reload: true, reason: `no updated factory is available for \`${id}\`` };
      }

      this.setStatus("dispose");
      this.applying = true;
      try {
        for (const id of plan.updateSet) {
          const context = this.moduleHotContexts.get(id);
          const data = {};
          if (context) {
            for (const handler of context._disposeHandlers.slice()) handler(data);
          }
          this.hotData.set(id, data);
        }

        const callbacks = plan.boundaries.slice();
        for (const id of plan.updateSet) {
          this.removeModuleCache(id);
          updated.add(id);
        }

        this.setStatus("apply");
        const initialized = new Set();
        const invoked = new Set();
        for (const boundary of callbacks) {
          if (!initialized.has(boundary.acceptedVia)) {
            this.initModule(boundary.acceptedVia);
            initialized.add(boundary.acceptedVia);
          }
          for (const record of boundary.records) {
            if (invoked.has(record)) continue;
            invoked.add(record);
            try {
              const modules = record.deps.map((dep) => this.loadExports(dep));
              record.callback(record.deps.length === 1 ? modules[0] : modules);
            } catch (error) {
              if (typeof record.errorHandler === "function") record.errorHandler(error);
              else throw error;
            }
          }
        }
        return { reload: false };
      } finally {
        this.applying = false;
      }
    }

    connect() {
      if (this.eventSource || typeof window === "undefined" || typeof EventSource === "undefined") return;
      const endpoint = `/__rustwrap_sse?clientId=${encodeURIComponent(this.clientId)}`;
      const source = new EventSource(endpoint);
      this.eventSource = source;
      source.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === "patch") {
          this.updateQueue = this.updateQueue.then(async () => {
            await import(message.url + (message.url.includes("?") ? "&" : "?") + "seq=" + message.seq);
            const outcome = this.applyUpdate(message.changedIds || []);
            if (outcome.reload) {
              console.log(`[@rustwrap/webpack] full reload: ${outcome.reason}`);
              location.reload();
            } else {
              console.log(`[@rustwrap/webpack] hot updated: ${outcome.updated.join(", ")}`);
            }
          }).catch((error) => {
            console.error("[@rustwrap/webpack] HMR apply failed", error);
            location.reload();
          });
        } else if (message.type === "reload") {
          console.log(`[@rustwrap/webpack] full reload${message.reason ? ": " + message.reason : ""}`);
          location.reload();
        } else if (message.type === "errors") {
          console.error("[@rustwrap/webpack] build failed\n" + (message.errors || []).join("\n"));
        }
      };
    }
  }

  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const randomId = root.crypto && typeof root.crypto.randomUUID === "function"
    ? root.crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  root.__rolldown_runtime__ ||= new RustwrapDevRuntime(randomId);
  root.__rustwrap_native_hmr__ = true;
  root.__rolldown_runtime__.connect();
}

function installFallbackClient() {
  if (typeof window === "undefined" || !window.EventSource || window.__rustwrap_native_hmr__) return;
  const hot = window.__rustwrap_hot__ || (window.__rustwrap_hot__ = (() => {
    const disposes = [];
    const statusHandlers = [];
    let status = "idle";
    const data = {};
    const setStatus = (next) => {
      status = next;
      for (const handler of statusHandlers) {
        try { handler(next); } catch (_) {}
      }
    };
    return {
      accept() {},
      decline() {},
      dispose(callback) { if (typeof callback === "function") disposes.push(callback); },
      addDisposeHandler(callback) { if (typeof callback === "function") disposes.push(callback); },
      removeDisposeHandler() {},
      invalidate() { location.reload(); },
      data,
      status() { return status; },
      addStatusHandler(callback) { statusHandlers.push(callback); },
      removeStatusHandler() {},
      apply() { return Promise.resolve([]); },
      check() { return Promise.resolve(null); },
      _disposes: disposes,
      _setStatus: setStatus,
    };
  })());
  const source = new EventSource("/__rustwrap_sse");
  source.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === "errors") {
      console.error("[@rustwrap/webpack] build failed\n" + (message.errors || []).join("\n"));
    } else if (message.type === "ok" || message.type === "reload") {
      hot._setStatus("dispose");
      for (const handler of hot._disposes) {
        try { handler(hot.data); } catch (_) {}
      }
      hot._setStatus("apply");
      location.reload();
    }
  };
}

const NATIVE_RUNTIME = `(${installNativeRuntime.toString()})();`;
const FALLBACK_CLIENT = `(${installFallbackClient.toString()})();`;

module.exports = { NATIVE_RUNTIME, FALLBACK_CLIENT };
