// v2 — A/B experiments. docs/ARCHITECTURE.md §6.
import { PageHeader, Card } from "@/components/ui";
import { ExperimentsManager } from "@/components/experiments-manager";

export default function ExperimentsPage() {
  return (
    <div>
      <PageHeader title="Experiments" subtitle="A/B tests with two-proportion significance" />
      <Card>
        <ExperimentsManager />
      </Card>
    </div>
  );
}
