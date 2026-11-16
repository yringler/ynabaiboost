// components/landing/ConnectButton.tsx — LANDING §6: CTA whose target depends on GET /auth/config and the cached `me`.
//   signed in (cached `me` query has data)  → "Open app"      → /
//   oauthAvailable                          → "Connect YNAB"  → /auth/ynab/start (plain <a>: Worker-first route, full navigation)
//   otherwise, or before config loads       → "Connect YNAB"  → /login
// The landing page never calls /api/me itself (LANDING §8: only the bundle and /auth/config are requested).
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { meQueryOptions } from "../../hooks/useMe";
import { call } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export interface ConnectTarget {
  href: string;
  label: string;
  signedIn: boolean;
}

export function useConnectTarget(): ConnectTarget {
  // Same key and options as the login page, so the answer is shared and fetched once per session.
  const config = useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: ({ signal }) => call("authConfig", { signal }),
    staleTime: Infinity,
  });
  // Observe the cache only (enabled: false): a logged-out visitor must not trigger a 401 round trip.
  const me = useQuery({ ...meQueryOptions, enabled: false });

  if (me.data) return { href: "/", label: "Open app", signedIn: true };
  if (config.data?.oauthAvailable === true) return { href: "/auth/ynab/start", label: "Connect YNAB", signedIn: false };
  return { href: "/login", label: "Connect YNAB", signedIn: false };
}

export function ConnectButton({ className, children }: { className?: string; children?: ReactNode }) {
  const t = useConnectTarget();
  return (
    <a className={["l-btn", "l-btn-primary", className].filter(Boolean).join(" ")} href={t.href}>
      {children ?? t.label}
    </a>
  );
}
