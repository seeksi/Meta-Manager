// Boots the background scheduler when the Node server starts (hosted or desktop).
// `register` runs once per server instance (Next docs: file-conventions/instrumentation).
// Edge/build-time are skipped. Bootstrap operator/client seeding (idempotent upserts) runs on
// EVERY Node instance — incl. web-only ones — so the rows exist; DISABLE_SCHEDULER=1 skips only
// the scheduler loop. Requires migrations applied (npm run db:migrate) — see docs/DEPLOY.md.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureBootstrapClient, ensureBootstrapOperator } = await import("@/lib/clients");
    await ensureBootstrapOperator();
    await ensureBootstrapClient();
  } catch (e) {
    console.error("[instrumentation] bootstrap operator/client seed failed:", e);
  }
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
