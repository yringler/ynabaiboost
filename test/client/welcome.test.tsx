import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomePage } from "../../src/client/routes/welcome";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("welcome route", () => {
  it("renders the landing page inside the app's providers", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ oauthAvailable: false }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <WelcomePage />
      </QueryClientProvider>,
    );
    expect(container.querySelector(".landing")).not.toBeNull();
    expect(container.querySelector("h1")).not.toBeNull();
  });
});
