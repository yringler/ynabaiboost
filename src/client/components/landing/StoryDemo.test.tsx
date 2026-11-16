// LANDING §8: StoryDemo renders its final state with an aria-label, and Replay remounts the stage (key changes).
// Also covers ConnectButton's /auth/config + cached `me` wiring and the page's landmarks/copy.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { ConnectButton } from "./ConnectButton";
import { LandingPage } from "./LandingPage";
import { STORY_LABEL, StoryDemo } from "./StoryDemo";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withClient(ui: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function stubAuthConfig(oauthAvailable: boolean | "fail") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/config") && oauthAvailable !== "fail") {
      return new Response(JSON.stringify({ oauthAvailable }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("StoryDemo", () => {
  it("renders the final state inside a labelled img, with decorative children hidden", () => {
    const { container } = render(<StoryDemo />);
    const stage = screen.getByRole("img");
    expect(stage.getAttribute("aria-label")).toBe(STORY_LABEL);
    expect(stage.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    // final state: the bank row carries the Groceries chip and a check; the quote is marked up as <q>
    expect(container.querySelector(".row .cat-new")?.textContent).toBe("Groceries");
    expect(container.querySelector(".row .check svg")).not.toBeNull();
    expect(container.querySelector(".bubble q")?.textContent).toBe("about 200 at Costco, groceries");
    expect(container.querySelector(".row .amt")?.textContent).toBe("−$212.47");
    // no IntersectionObserver in jsdom → treated as in view, so the timeline runs
    expect(container.querySelector("figure.story")?.classList.contains("is-on")).toBe(true);
  });

  it("Replay is a real button outside the img and remounts the stage", () => {
    render(<StoryDemo />);
    const before = screen.getByRole("img");
    expect(before.getAttribute("data-run")).toBe("0");
    const replay = screen.getByRole("button", { name: "Replay" });
    expect(before.contains(replay)).toBe(false);

    act(() => fireEvent.click(replay));
    const after = screen.getByRole("img");
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.getAttribute("data-run")).toBe("1");
  });
});

describe("ConnectButton", () => {
  it("points to /login before /auth/config answers", () => {
    stubAuthConfig(true);
    withClient(<ConnectButton />);
    const a = screen.getByRole("link", { name: "Connect YNAB" });
    expect(a.getAttribute("href")).toBe("/login");
  });

  it("uses the OAuth start route when oauthAvailable", async () => {
    const fetchMock = stubAuthConfig(true);
    withClient(<ConnectButton />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Connect YNAB" }).getAttribute("href")).toBe("/auth/ynab/start"),
    );
    // only /auth/config is requested — never /api/me
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/auth/config"]);
  });

  it("stays on /login when OAuth is off or config fails", async () => {
    const fetchMock = stubAuthConfig(false);
    withClient(<ConnectButton />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Connect YNAB" }).getAttribute("href")).toBe("/login");

    cleanup();
    stubAuthConfig("fail");
    withClient(<ConnectButton />);
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Connect YNAB" }).getAttribute("href")).toBe("/login");
  });

  it("becomes Open app → / when the me query is cached", () => {
    stubAuthConfig(true);
    const client = new QueryClient();
    client.setQueryData(queryKeys.me, { userId: "u1" });
    withClient(<ConnectButton />, client);
    expect(screen.getByRole("link", { name: "Open app" }).getAttribute("href")).toBe("/");
  });
});

describe("LandingPage", () => {
  it("has the landmarks, one h1, section h2s and the CTA links", () => {
    stubAuthConfig(false);
    const { container } = withClient(<LandingPage />);
    expect(container.querySelector(".landing")).not.toBeNull();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Site" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Say what you spent."]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "How it works",
      "One order, three charges.",
      "Your keys, your budget.",
      "Try it on your next receipt.",
    ]);
    expect(container.querySelector("ol.steps")?.children).toHaveLength(3);
    expect(container.querySelector("#how")).not.toBeNull();
    expect(screen.getByRole("link", { name: "How it works" }).getAttribute("href")).toBe("#how");
    expect(screen.getAllByRole("link", { name: "Connect YNAB" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Use a personal access token" }).getAttribute("href")).toBe("/login?pat=1");
    expect(screen.getAllByRole("link", { name: "Privacy" }).every((a) => a.getAttribute("href") === "/privacy")).toBe(true);
    // two labelled pictures: story, split
    expect(screen.getAllByRole("img").every((el) => (el.getAttribute("aria-label") ?? "").length > 20)).toBe(true);
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });
});
