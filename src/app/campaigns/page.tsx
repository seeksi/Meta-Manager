// Module 3 — Budget management. Campaign list (from Meta once connected) + budget editor.
// Budget writes route through proposeAction → guardrails → executor. docs/PRODUCT_SPEC.md §3.
import { PageHeader, Card } from "@/components/ui";
import { BudgetEditor } from "@/components/budget-editor";

export default function CampaignsPage() {
  return (
    <div>
      <PageHeader title="Campaigns" subtitle="Budgets route through the guardrail pipeline" />

      <Card className="mb-4 bg-amber-50 dark:bg-amber-950/30 text-sm">
        Campaign list loads once a Meta ad account is connected (Settings → Meta Connection).
        Until then, use the budget editor below — it exercises the live guardrail + approval flow.
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Budget editor</h2>
        <p className="mb-4 text-sm text-black/60 dark:text-white/60">
          Set an absolute daily budget. The change is evaluated against your guardrails: small
          changes within caps apply immediately (Tier A); larger increases queue for approval (Tier B).
        </p>
        <BudgetEditor />
      </Card>
    </div>
  );
}
