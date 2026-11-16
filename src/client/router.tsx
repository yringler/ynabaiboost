// router.tsx — WP6 (DESIGN §11.1–§11.2; LANDING §6): TanStack Router, code-based routes. Placeholder created by WP1.
// TODO(WP6): guards — logged-out "/" → "/welcome"; other protected routes 401 → "/login"; onboarding redirects.
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { ActivityPage } from "./routes/activity";
import { AdminPage } from "./routes/admin";
import { CapturePage } from "./routes/capture";
import { InboxPage } from "./routes/inbox";
import { LoginPage } from "./routes/login";
import { OnboardingPage } from "./routes/onboarding";
import { PendingPage } from "./routes/pending";
import { PrivacyPage } from "./routes/privacy";
import { SettingsPage } from "./routes/settings";
import { WelcomePage } from "./routes/welcome";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: CapturePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/welcome", component: WelcomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/onboarding", component: OnboardingPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/pending", component: PendingPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: InboxPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/privacy", component: PrivacyPage }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
