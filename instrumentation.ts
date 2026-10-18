export async function register() {
  // Only run on the Node.js server runtime, not in the browser/edge
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.LINKI_DISABLE_BACKGROUND !== "1") {
    if (process.env.NODE_ENV === "production") {
      const { assertProductionRuntime } = await import("@/lib/runtime-config");
      assertProductionRuntime();
    }
    try {
      const { ensureGlobalRunnerStarted } = await import("@/lib/linkedin/runner");
      ensureGlobalRunnerStarted();
    } catch (err) {
      console.error("[instrumentation] Failed to start runner:", err);
    }
  }
}
