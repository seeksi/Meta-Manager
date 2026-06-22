// Module 8 — Settings optimization & auto-launch. docs/PRODUCT_SPEC.md §8.
import { PageHeader, Card } from "@/components/ui";
import { OptimizePanel } from "@/components/optimize-panel";
import { FatiguePanel } from "@/components/fatigue-panel";

export default function OptimizePage() {
  return (
    <div>
      <PageHeader title="Optimize" subtitle="Tier A auto-applied within caps · Tier B awaits approval" />
      <Card className="mb-4 text-sm text-black/60 dark:text-white/60">
        The optimizer reads a 7-day metric window and proposes actions: it auto-pauses clear
        losers and cautiously decreases budgets (Tier A, within caps), and never auto-scales —
        growth is always Tier B. Confidence gates + a per-entity cooldown prevent thrashing.
      </Card>
      <Card className="mb-4">
        <OptimizePanel />
      </Card>
      <Card>
        <h2 className="mb-3 font-medium">Creative fatigue</h2>
        <p className="mb-3 text-sm text-black/60 dark:text-white/60">
          Advisory signals from a 7-day window: rising frequency or declining CTR mean a creative
          is wearing out. Refreshing creative is a manual decision — no auto-write.
        </p>
        <FatiguePanel />
      </Card>
    </div>
  );
}
