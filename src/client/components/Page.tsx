// components/Page.tsx — WP6: page scaffolding shared by shell and public screens.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** Centered column for screens outside the shell (login, onboarding, privacy). */
export function PlainPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cn("px-safe pt-safe pb-safe mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 py-8", className)}>
      {children}
    </main>
  );
}

export function PageTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h1 className="text-xl font-semibold tracking-tight">{children}</h1>
      {action}
    </div>
  );
}
