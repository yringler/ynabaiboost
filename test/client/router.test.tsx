import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../src/client/lib/queryClient";
import { createAppRouter } from "../../src/client/router";
import { DEFAULT_SETTINGS, type Me } from "../../src/shared/schemas";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const meFixture = (over: Partial<Me> = {}): Me => ({
  userId: "u-1", isAdmin: false, authType: "pat", needsReauth: false, sttAllowed: false, hasAnthropicKey: true,
  oauthAvailable: false, settings: { ...DEFAULT_SETTINGS, planId: "p1", aiDataConsent: true },
  plan: { id: "p1", name: "Plan", currency: { isoCode: "USD", decimalDigits: 2 } },
  counts: { pending: 0, stale: 0, review: 0 }, lastSyncError: null, lastSyncAt: null, ...over,
});

function setup(path: string, meResponse: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/me")) return meResponse();
    if (url.startsWith("/auth/config")) return json({ oauthAvailable: false });
    if (url.startsWith("/api/plans")) return json({ plans: [] });
    if (url.startsWith("/api/catalog")) return json({ error: { code: "no_plan_selected", message: "x" } }, 409);
    return json({ error: { code: "not_found", message: "x" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = createAppQueryClient(() => {});
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, fetchMock };
}

const unauth = () => json({ error: { code: "unauthenticated", message: "no session" } }, 401);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route guards", () => {
  it("sends a logged-out visitor at / to /welcome", async () => {
    const { router } = setup("/", unauth);
    await waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
  });

  it("sends a logged-out deep link to /login with a redirect back", async () => {
    const { router } = setup("/pending", unauth);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({ redirect: "/pending" });
  });

  it("sends a not-allowed user to /login?error=not_allowed with their id", async () => {
    const { router } = setup("/", () => json({ error: { code: "not_allowed", message: "Send your user id abc-123 to the owner" } }, 403));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({ error: "not_allowed", uid: "abc-123" });
  });

  it("sends a user without consent or key to /onboarding", async () => {
    const { router } = setup("/pending", () => json(meFixture({ hasAnthropicKey: false })));
    await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
  });

  it("keeps non-admins out of /admin", async () => {
    const { router } = setup("/admin", () => json(meFixture()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("never calls POST /api/sync on its own", async () => {
    const { router, fetchMock } = setup("/", () => json(meFixture()));
    await waitFor(() => expect(router.state.status).toBe("idle"));
    await screen.findByRole("heading", { name: "Capture" });
    expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
    expect(screen.getByText("Never synced")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/sync"))).toBe(false);
  });
});

describe("screens render against contract-shaped data", () => {
  const routes: Record<string, unknown> = {
    "/api/catalog": {
      planId: "p1", currency: { isoCode: "USD", decimalDigits: 2 },
      categories: [{ id: "c1", groupId: "g", groupName: "Everyday", name: "Dining out" }],
      accounts: [{ id: "a1", name: "Visa", type: "creditCard", onBudget: true, closed: false, directImportLinked: true }],
      payees: [], recentCategoryIds: ["c1"],
    },
    "/api/reviews": { reviews: [] },
    "/api/intents": { intents: [] },
    "/api/activity": { entries: [{ id: "e1", at: 1_700_000_000_000, actor: "cron", action: "txn_approved", summary: "Approved Starbucks", intentId: null, transactionId: "t1" }], nextCursor: null },
  };
  function setupWithData(path: string) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split("?")[0] ?? "";
      if (url === "/api/me") return json(meFixture());
      if (url in routes) return json(routes[url]);
      return json({ error: { code: "not_found", message: url } }, 404);
    }));
    const qc = createAppQueryClient(() => {});
    const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
  }

  it("pending shows empty tabs", async () => {
    setupWithData("/pending");
    await screen.findByText("No purchases waiting for the bank.");
  });
  it("settings shows the user id", async () => {
    setupWithData("/settings");
    expect((await screen.findByTestId("user-id")).textContent).toBe("u-1");
  });
  it("activity lists entries", async () => {
    setupWithData("/activity");
    await screen.findByText("Approved Starbucks");
  });
});
