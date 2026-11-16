// §9.6 / §11.2: Pending screen multi-select + "Edit by voice or text" sheet (preview → Apply by token).
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../src/client/lib/queryClient";
import { createAppRouter } from "../../src/client/router";
import { DEFAULT_SETTINGS, type Intent, type Me } from "../../src/shared/schemas";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const me: Me = {
  userId: "u-1", isAdmin: false, authType: "pat", needsReauth: false, sttAllowed: false, hasAnthropicKey: true,
  oauthAvailable: false, settings: { ...DEFAULT_SETTINGS, planId: "p1", aiDataConsent: true },
  plan: { id: "p1", name: "Plan", currency: { isoCode: "USD", decimalDigits: 2 } },
  counts: { pending: 2, stale: 0, review: 0 }, lastSyncError: null, lastSyncAt: null,
};

const intent = (id: string, payee: string, total: number): Intent => ({
  id, shortRef: "ABC123", status: "pending", isStale: false, rawText: `${payee} about ${total / 1000}`, payee, payeeId: null,
  merchantKind: "in_person", direction: "outflow", date: "2026-11-14", accountId: "a1", accountExplicit: false,
  totalAmount: total, tolerance: 1000, approximate: true, memo: null, precision: { level: "approximate", note: null },
  placeholder: { txnId: null, status: "none", amount: null }, expiresOn: "2026-12-31", createdAt: total, resolvedAt: null,
  lines: [{ id: `${id}-l`, idx: 0, description: "stuff", categoryId: "c1", amount: total, tolerance: 1000, approximate: true, status: "open", matchedTxnId: null }],
  matchedTransactionIds: [],
});

const PREVIEW = {
  token: "tok-0123456789abcdef", expiresAt: Date.now() + 900_000, summary: "Set Costco to 212.47",
  lines: ["Costco · total ≈$200.00 → $212.47 (exact)"], dropped: ["Target isn't selected. Select it to change it"],
  question: null, needsConfirmation: true, applied: false, results: [], warnings: [],
};
const APPLIED = {
  ...PREVIEW, token: null, expiresAt: null, dropped: [], needsConfirmation: false, applied: true,
  results: [{ line: PREVIEW.lines[0], ok: true, error: null }],
};

function setup() {
  const bodies: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    if (init?.method === "POST") bodies.push({ url, body });
    if (url.startsWith("/api/me")) return json(me);
    if (url.startsWith("/api/catalog")) {
      return json({ planId: "p1", currency: { isoCode: "USD", decimalDigits: 2 }, categories: [{ id: "c1", groupId: "g", groupName: "Everyday", name: "Groceries" }],
        accounts: [], payees: [], recentCategoryIds: [] });
    }
    if (url.startsWith("/api/reviews")) return json({ reviews: [] });
    if (url.startsWith("/api/intents?status=open")) return json({ intents: [intent("i-costco", "Costco", 200_000), intent("i-target", "Target", 40_000)] });
    if (url.startsWith("/api/intents?status=stale")) return json({ intents: [] });
    if (url === "/api/intents/edit") return json(PREVIEW);
    if (url === "/api/intents/edit/apply") return json(APPLIED);
    return json({ error: { code: "not_found", message: "x" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = createAppQueryClient(() => {});
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/pending?tab=pending"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { bodies };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pending: edit by voice or text", () => {
  it("select an item, preview the plan, apply by token", async () => {
    const user = userEvent.setup();
    const { bodies } = setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select Costco" }));
    const bar = screen.getByRole("toolbar", { name: "Edit pending items" });
    expect(within(bar).getByText("1 selected")).toBeTruthy();
    await user.click(within(bar).getByRole("button", { name: /Edit by voice or text/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Changing: Costco")).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "make it 212.47");
    await user.click(within(dialog).getByRole("button", { name: /Preview/ }));

    expect(await within(dialog).findByText("Costco · total ≈$200.00 → $212.47 (exact)")).toBeTruthy();
    expect(within(dialog).getByText("Target isn't selected. Select it to change it")).toBeTruthy();
    expect(bodies.find((b) => b.url === "/api/intents/edit")?.body).toEqual({ text: "make it 212.47", selectedIntentIds: ["i-costco"], inputMode: "typed" });

    await user.click(within(dialog).getByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Apply sends only the server-issued token, never the action list.
    expect(bodies.find((b) => b.url === "/api/intents/edit/apply")?.body).toEqual({ token: "tok-0123456789abcdef" });
    expect(screen.getByRole("checkbox", { name: "Select Costco" })).toHaveProperty("checked", false);
  });

  it("works with nothing selected, and from the detail sheet with that item preselected", async () => {
    const user = userEvent.setup();
    const { bodies } = setup();
    const bar = await screen.findByRole("toolbar", { name: "Edit pending items" });
    await user.click(within(bar).getByRole("button", { name: /Edit by voice or text/ }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nothing selected/)).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: "What should change?" }), "the Costco one was on the Amex");
    await user.click(within(dialog).getByRole("button", { name: /Preview/ }));
    await within(dialog).findByText("Costco · total ≈$200.00 → $212.47 (exact)");
    expect(bodies.at(-1)?.body).toMatchObject({ selectedIntentIds: [] });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: /^Target, .*Details$/ }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Edit by voice or text/ }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Changing: Target"));
  });
});
