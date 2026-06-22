// Scheduler status + on-demand triggers. Desktop automation only runs while the app is
// open, so the operator needs to see last/next runs and force a run now.
import { getSchedulerStatus, runPoll, runOptimize } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ status: getSchedulerStatus() });
}

export async function POST(req: Request) {
  try {
    const { job } = await req.json();
    if (job === "poll") return Response.json({ ok: true, result: await runPoll() });
    if (job === "optimize") return Response.json({ ok: true, result: await runOptimize() });
    return Response.json({ error: "unknown job" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
