// Settings → Setup. Guided in-app walkthrough (mirrors docs/META_SETUP.md) + a form to
// paste credentials straight into .env. docs/PRODUCT_SPEC.md §1.
import { PageHeader, Card } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { MetaKeysForm } from "@/components/meta-keys-form";

export const dynamic = "force-dynamic";

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a className="underline" href={href} target="_blank" rel="noreferrer">{children}</a>
);

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "1. Prerequisites",
    body: (
      <>You need a Facebook account that is an <strong>admin</strong> of a{" "}
        <A href="https://business.facebook.com/settings">Meta Business Portfolio</A>, with an{" "}
        ad account that has an active payment method. If you already run ads, you have these.</>
    ),
  },
  {
    title: "2. Create a developer account + app",
    body: (
      <>Go to <A href="https://developers.facebook.com/apps">developers.facebook.com/apps</A> →{" "}
        <strong>Create app</strong> (register/verify as a developer the first time). Use case:{" "}
        <strong>Other</strong> → app type: <strong>Business</strong>. Name it, select your Business
        Portfolio, create. Then <strong>Add product → Marketing API → Set up</strong>.</>
    ),
  },
  {
    title: "3. Collect App ID + Secret",
    body: (
      <><strong>App ID</strong> is at the top of the dashboard. <strong>App Secret</strong> is under{" "}
        <em>App settings → Basic → Show</em>. Paste both below (the secret stays server-side, never
        in the browser bundle).</>
    ),
  },
  {
    title: "4. Create a System User token (the important one)",
    body: (
      <>In <A href="https://business.facebook.com/settings">Business Settings → Users → System Users</A>{" "}
        → <strong>Add</strong> (role Admin). Then <strong>Add Assets</strong> → assign your{" "}
        <em>app</em> (Manage app) and <em>ad account</em> (Manage campaigns). Finally{" "}
        <strong>Generate new token</strong> → pick your app → <strong>Expiration: Never</strong> →
        scopes <code>ads_management</code>, <code>ads_read</code>, <code>business_management</code>.{" "}
        Copy it now (shown once) and paste below. Sanity-check it in the{" "}
        <A href="https://developers.facebook.com/tools/debug/accesstoken">Token Debugger</A>.</>
    ),
  },
  {
    title: "5. Ad Account ID (+ Page ID to launch)",
    body: (
      <>From <em>Business Settings → Accounts → Ad accounts</em> — paste the number with or without{" "}
        <code>act_</code>. To <strong>launch ads</strong>, also grab a <strong>Page ID</strong>{" "}
        (Accounts → Pages) and assign that Page asset to the same System User.</>
    ),
  },
  {
    title: "6. Pixel / CAPI (optional)",
    body: (
      <>For conversion tracking, copy your Pixel/Dataset ID from{" "}
        <A href="https://business.facebook.com/events_manager">Events Manager</A> and assign the
        Pixel asset to the System User. Skip if you only want metrics + budget/creative management.</>
    ),
  },
];

export default function SetupPage() {
  return (
    <div>
      <PageHeader title="Settings" subtitle="Set up your Meta app and save API keys" />
      <SettingsTabs />

      <Card className="mb-4">
        <h2 className="mb-1 font-medium">Guided setup</h2>
        <p className="mb-3 text-sm text-black/60 dark:text-white/60">
          ~20–30 min. Managing <strong>your own</strong> ad account needs no App Review — a System
          User with asset access is enough. The app stays safe meanwhile: kill switch engaged and{" "}
          <code>WRITE_MODE=off</code> by default.
        </p>
        <ol className="space-y-3 text-sm">
          {STEPS.map((s) => (
            <li key={s.title}>
              <div className="font-medium">{s.title}</div>
              <p className="text-black/70 dark:text-white/70">{s.body}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="mb-4">
        <h2 className="mb-1 font-medium">API keys</h2>
        <p className="mb-3 text-sm text-black/60 dark:text-white/60">
          Paste the values from the steps above. They save into your local <code>.env</code> and take
          effect immediately — no restart needed.
        </p>
        <MetaKeysForm />
      </Card>

      <Card className="text-sm text-black/60 dark:text-white/60">
        Full reference (troubleshooting, scopes, access levels): <code>docs/META_SETUP.md</code> in the
        project. Also set a <strong>native Meta account spend cap</strong> as the external backstop.
      </Card>
    </div>
  );
}
