// Boots the local background scheduler when the Node server starts (desktop build).
// `register` runs once per server instance (Next docs: file-conventions/instrumentation).
// Edge runtime, build-time, and DISABLE_SCHEDULER=1 are skipped.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  try {
    const { ensureBootstrapClient } = await import("@/lib/clients");
    await ensureBootstrapClient();
  } catch (e) {
    console.error("[instrumentation] bootstrap client seed failed:", e);
  }
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
