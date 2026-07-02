"use client";
// App shell: sidebar nav (mirrors docs/ARCHITECTURE.md sitemap) + header with the
// global kill-switch. ponytail: hand-rolled Tailwind. Upgrade path: shadcn/ui primitives.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClientSwitcher } from "@/components/client-switcher";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/ads/new", label: "Ad Builder" },
  { href: "/creatives", label: "Creatives" },
  { href: "/research", label: "Research" },
  { href: "/leads", label: "Leads" },
  { href: "/optimize", label: "Optimize" },
  { href: "/audit", label: "Audit" },
  { href: "/experiments", label: "Experiments" },
  { href: "/automation", label: "Automation" },
  { href: "/settings/setup", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") {
    return <main className="flex min-h-screen items-center justify-center p-6">{children}</main>;
  }
  return (
    <div className="flex min-h-full">
      <aside className="w-56 shrink-0 border-r border-black/10 dark:border-white/10 p-4">
        <div className="mb-6 font-semibold tracking-tight">Meta Ads Manager</div>
        <nav className="flex flex-col gap-1 text-sm">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 transition-colors ${
                  active ? "bg-black/10 dark:bg-white/10 font-medium" : "hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-black/10 dark:border-white/10 px-6 py-3">
          <ClientSwitcher />
          <KillSwitch />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function KillSwitch() {
  async function kill() {
    if (!confirm("Engage kill-switch? This halts ALL automated writes to Meta.")) return;
    const res = await fetch("/api/automation/kill", { method: "POST" });
    if (res.ok) {
      alert("Kill-switch engaged — all automated writes halted.");
      location.reload();
    } else {
      const { error } = await res.json().catch(() => ({ error: "unknown" }));
      alert(`Could not engage kill-switch: ${error}. Also use the native Meta account spend cap.`);
    }
  }
  return (
    <button
      onClick={kill}
      className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
    >
      ⛔ Kill switch
    </button>
  );
}
