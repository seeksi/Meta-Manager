"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/setup", label: "Setup & API Keys" },
  { href: "/settings/connection", label: "Connection" },
  { href: "/settings/clients", label: "Clients" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <div className="mb-4 flex gap-1 border-b border-black/10 dark:border-white/10">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-blue-600 font-medium"
                : "border-transparent text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
