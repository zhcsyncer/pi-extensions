export interface CleanupScope {
  run<T>(callback: () => T): T;
  register(callback: () => void): void;
  dispose(): void;
  readonly count: number;
}

let activeScope: CleanupScope | undefined;

/** Capture ownership even when a renderer registers a timer long after extension loading. */
export function createCleanupScope(): CleanupScope {
  let callbacks: Array<() => void> = [];
  let disposed = false;
  const scope: CleanupScope = {
    run(callback) {
      const previous = activeScope;
      activeScope = scope;
      try { return callback(); } finally { activeScope = previous; }
    },
    register(callback) {
      if (disposed) callback();
      else callbacks.push(callback);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const callback of callbacks.reverse()) {
        try { callback(); } catch (cleanupError) { void cleanupError; }
      }
      callbacks = [];
    },
    get count() { return callbacks.length; },
  };
  return scope;
}

let defaultScope = createCleanupScope();
export function registerCleanup(callback: () => void): void {
  (activeScope ?? defaultScope).register(callback);
}
export function registerTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  registerCleanup(() => clearInterval(timer as ReturnType<typeof setInterval>));
}
export function disposeAll(): void { defaultScope.dispose(); }
export function resetDisposed(): void { defaultScope = createCleanupScope(); }
export function getCleanupCount(): number { return defaultScope.count; }
