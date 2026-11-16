// router.tsx — WP6 (DESIGN §11.1–§11.2; LANDING §6): TanStack Router, code-based routes and guards.
//   public : /welcome (landing), /login, /privacy
//   authed : GET /api/me must succeed.  401 on "/" → /welcome; 401 elsewhere → /login; 403 not_allowed → /login?error=not_allowed
//     /onboarding
//     shell (header + bottom nav): plan, Anthropic key and AI consent required, else → /onboarding
//       /, /pending, /activity, /settings, /admin (admins only)
// App screens are code-split so the public landing page (/welcome) stays light.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Link, Outlet, redirect, useRouter,
  type ErrorComponentProps, type RouterHistory,
} from "@tanstack/react-router";
import type { Me } from "../shared/schemas";
import { PlainPage } from "./components/Page";
import { Button } from "./components/ui/button";
import { meQueryOptions, needsOnboarding } from "./hooks/useMe";
import { errorMessage, isApiError } from "./lib/api";
import { WelcomePage } from "./routes/welcome";
import { extractUserId, parseLoginSearch, type PendingSearch } from "./lib/routing";

export type { LoginSearch, PendingSearch, PendingTab } from "./lib/routing";

export interface RouterContext {
  queryClient: QueryClient;
}

function RootError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <PlainPage className="justify-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <div className="flex gap-2">
        <Button
          className="h-11"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link to="/welcome">Home</Link>
        </Button>
      </div>
    </PlainPage>
  );
}

function NotFound() {
  return (
    <PlainPage className="justify-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Button asChild className="h-11 w-fit">
        <Link to="/">Go to the app</Link>
      </Button>
    </PlainPage>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

// ── public ─────────────────────────────────────────────────────────────────
const welcomeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/welcome", component: WelcomePage });
export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: parseLoginSearch,
  component: lazyRouteComponent(() => import("./routes/login"), "LoginPage"),
});
const privacyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/privacy", component: lazyRouteComponent(() => import("./routes/privacy"), "PrivacyPage") });

// ── authenticated ──────────────────────────────────────────────────────────
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context, location }): Promise<{ me: Me }> => {
    try {
      const me = await context.queryClient.ensureQueryData(meQueryOptions);
      return { me };
    } catch (e) {
      if (isApiError(e)) {
        if (e.code === "not_allowed") {
          const uid = extractUserId(e.message);
          throw redirect({ to: "/login", search: uid ? { error: "not_allowed", uid } : { error: "not_allowed" } });
        }
        if (e.status === 401) {
          if (location.pathname === "/") throw redirect({ to: "/welcome" });
          throw redirect({ to: "/login", search: { redirect: location.href } });
        }
      }
      throw e;
    }
  },
  component: () => <Outlet />,
});

const onboardingRoute = createRoute({ getParentRoute: () => authedRoute, path: "/onboarding", component: lazyRouteComponent(() => import("./routes/onboarding"), "OnboardingPage") });

const shellRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "shell",
  beforeLoad: ({ context }) => {
    if (needsOnboarding(context.me)) throw redirect({ to: "/onboarding" });
  },
  component: lazyRouteComponent(() => import("./components/AppShell"), "AppShell"),
});

export const captureRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: lazyRouteComponent(() => import("./routes/capture"), "CapturePage") });
export const pendingRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/pending",
  validateSearch: (s: Record<string, unknown>): PendingSearch =>
    s.tab === "review" || s.tab === "pending" || s.tab === "stale" ? { tab: s.tab } : {},
  component: lazyRouteComponent(() => import("./routes/pending"), "PendingPage"),
});
const activityRoute = createRoute({ getParentRoute: () => shellRoute, path: "/activity", component: lazyRouteComponent(() => import("./routes/activity"), "ActivityPage") });
const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/settings", component: lazyRouteComponent(() => import("./routes/settings"), "SettingsPage") });
const adminRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin",
  beforeLoad: ({ context }) => {
    if (!context.me.isAdmin) throw redirect({ to: "/" });
  },
  component: lazyRouteComponent(() => import("./routes/admin"), "AdminPage"),
});

export const routeTree = rootRoute.addChildren([
  welcomeRoute,
  loginRoute,
  privacyRoute,
  authedRoute.addChildren([
    onboardingRoute,
    shellRoute.addChildren([captureRoute, pendingRoute, activityRoute, settingsRoute, adminRoute]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
    defaultPreload: false,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
