// Module 7 — Competitor creative research. docs/PRODUCT_SPEC.md §7.
import { PageHeader, Card } from "@/components/ui";
import { ResearchBrowser } from "@/components/research-browser";

export default function ResearchPage() {
  return (
    <div>
      <PageHeader title="Competitor Research" subtitle="Ad Library creatives, long-runners & patterns" />
      <Card>
        <ResearchBrowser />
      </Card>
    </div>
  );
}
