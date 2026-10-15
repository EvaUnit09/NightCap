/**
 * Server-start hook. `register` runs when a Next.js server instance starts,
 * not as a substitute for `next build` evaluating modules.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }
  const {
    assertProductionLiveRoutes,
    assertProductionRequestHashSecret,
    assertProductionSpendStore,
  } = await import("./src/models/config");
  assertProductionLiveRoutes();
  assertProductionRequestHashSecret();
  assertProductionSpendStore();
  const { registerDatadogTracing } = await import("./src/monitoring/datadog-exporter");
  await registerDatadogTracing();
}
