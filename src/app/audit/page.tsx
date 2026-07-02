import { AuditPanel } from "@/components/audit-panel";
import { Card, PageHeader } from "@/components/ui";
import { activeClientId } from "@/lib/active-client";

export default async function AuditPage() {
  const clientId = await activeClientId();
  return (
    <div>
      <PageHeader title="Audit" subtitle="Read-only account health · fixes require approval (coming in a later milestone)" />
      <Card className="mb-4 text-sm text-black/60 dark:text-white/60">
        This audit scores the signals available today from stored account data plus the Pixel/CAPI
        questionnaire. It does not write to Meta; any fix workflow arrives in a later milestone.
      </Card>
      <AuditPanel clientId={clientId} />
    </div>
  );
}
