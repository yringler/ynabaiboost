// components/BottomNav.tsx — WP6 (DESIGN §11.1): Capture · Pending(badge) · Settings.
import { Link } from "@tanstack/react-router";
import { ListTodoIcon, MicIcon, SettingsIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Me } from "../../shared/schemas";

interface Item {
  to: "/" | "/pending" | "/settings";
  label: string;
  icon: ComponentType<{ className?: string }>;
  badge?: number;
}

export function BottomNav({ counts }: { counts: Me["counts"] | null }) {
  const items: Item[] = [
    { to: "/", label: "Capture", icon: MicIcon },
    // Pending's badge counts what needs the user: reviews plus stale intents.
    { to: "/pending", label: "Pending", icon: ListTodoIcon, badge: counts ? counts.review + counts.stale : 0 },
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <ul className="mx-auto flex max-w-xl">
        {items.map(({ to, label, icon: Icon, badge }) => (
          <li key={to} className="flex-1">
            <Link
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground data-[status=active]:text-primary"
            >
              <span className="relative">
                <Icon className="size-5" />
                {badge !== undefined && badge > 0 && (
                  <span
                    className="tabular absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground"
                    aria-label={`${badge} need attention`}
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </span>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
