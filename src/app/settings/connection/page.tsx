// Module 1 — Meta API onboarding. Guided checklist + verify. docs/PRODUCT_SPEC.md §1.
import { PageHeader, Card } from "@/components/ui";
import { VerifyButton } from "@/components/verify-button";
import { connectionStatus } from "@/lib/connection";

export const dynamic = "force-dynamic";

export default function ConnectionPage() {
  const status = connectionStatus();
  const requiredDone = status.steps.filter((s) => s.required).every((s) => s.done);

  return (
    <div>
      <PageHeader title="Meta Connection" subtitle={`Marketing API ${status.apiVersion}`} />

      <Card className="mb-4">
        <h2 className="mb-3 font-medium">Setup checklist</h2>
        <ul className="space-y-2 text-sm">
          {status.steps.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className={s.done ? "text-green-600" : "text-black/30 dark:text-white/30"}>
                {s.done ? "✓" : "○"}
              </span>
              <span className={s.done ? "" : "text-black/70 dark:text-white/70"}>{s.label}</span>
              {!s.required && <span className="text-xs text-black/40 dark:text-white/40">(optional)</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3 text-sm">
          {requiredDone
            ? <span className="text-green-700 dark:text-green-400">All required credentials present.</span>
            : <span className="text-amber-700 dark:text-amber-400">Add the remaining required credentials to .env (see .env.example).</span>}
        </div>
      </Card>

      <Card className="mb-4">
        <h2 className="mb-2 font-medium">Verify</h2>
        <VerifyButton />
      </Card>

      <Card className="text-sm text-black/60 dark:text-white/60 space-y-2">
        <p className="font-medium text-black dark:text-white">How to connect</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Create a Meta app (Business type) at <a className="underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">developers.facebook.com</a> and add the Marketing API product.</li>
          <li>In Business Settings, create a System User and generate a <strong>never-expiring</strong> token with <code>ads_management</code>, <code>ads_read</code>, <code>business_management</code> — after assigning your app + ad account to that system user.</li>
          <li>Note your ad account ID (with or without <code>act_</code>) and add the credentials to .env.</li>
          <li>Optional: configure the Pixel + Conversions API for conversion tracking.</li>
        </ol>
        <p className="text-xs">
          Full walkthrough: <code>docs/META_SETUP.md</code>. Managing <strong>your own</strong> ad account does
          not require App Review — a System User with asset access is enough. Set a native account spend cap
          in Meta as the external backstop.
        </p>
      </Card>
    </div>
  );
}
