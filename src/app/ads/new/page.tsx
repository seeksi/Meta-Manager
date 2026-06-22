// Modules 4+5 — Ad builder + inline AI copywriting. docs/PRODUCT_SPEC.md §4–5.
// Copy generation is live here; creative assembly + launch lands with module #7.
import { PageHeader, Card } from "@/components/ui";
import { CopyGenerator } from "@/components/copy-generator";
import { AdAssembler } from "@/components/ad-assembler";

export default function AdBuilderPage() {
  return (
    <div>
      <PageHeader title="Ad Builder" subtitle="Generate copy, assemble creative, queue launch" />

      <Card className="mb-4">
        <h2 className="mb-3 font-medium">AI copywriting</h2>
        <p className="mb-4 text-sm text-black/60 dark:text-white/60">
          Generate Meta-compliant variants (headline / primary text / description) conditioned on
          your brand voice. Character counts and over-limit flags are shown per field.
        </p>
        <CopyGenerator />
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">Assemble & launch</h2>
        <p className="mb-4 text-sm text-black/60 dark:text-white/60">
          Pick a creative, attach copy + CTA + destination, then queue the launch. Launches are
          Tier B — they land in the approval queue with a re-check before going live.
        </p>
        <AdAssembler />
      </Card>
    </div>
  );
}
