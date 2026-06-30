import { ClientsManager } from "@/components/clients-manager";
import { SettingsTabs } from "@/components/settings-tabs";
import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function ClientsPage() {
  return (
    <div>
      <PageHeader title="Settings" subtitle="Onboard and manage client ad accounts" />
      <SettingsTabs />

      <Card className="mb-4 text-sm text-black/60 dark:text-white/60">
        New clients are created in <strong>observe mode with the kill switch engaged</strong>, and
        must pass a live <strong>Verify access</strong> check before the engine will poll them.
      </Card>

      <ClientsManager />
    </div>
  );
}
