// Modules 6+9 — Lead funnel + conversion/retention. docs/PRODUCT_SPEC.md §6, §9.
import { PageHeader, Card } from "@/components/ui";
import { LeadsManager } from "@/components/leads-manager";
import { AttributionPanel } from "@/components/attribution-panel";

export default function LeadsPage() {
  return (
    <div>
      <PageHeader title="Leads" subtitle="Funnel, stages, scoring & nurture" />
      <Card className="mb-4">
        <LeadsManager />
      </Card>
      <Card>
        <h2 className="mb-3 font-medium">Attribution — cost per lead by campaign (7d)</h2>
        <AttributionPanel />
      </Card>
    </div>
  );
}
