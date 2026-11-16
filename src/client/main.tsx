// main.tsx — WP6 (DESIGN §11.1): QueryClientProvider, RouterProvider, Toaster.
// With VITE_MOCK_API set (dev only), MSW browser mocks built from the shared schemas answer /api/* and /auth/*.
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "./index.css";
import { createAppQueryClient } from "./lib/queryClient";
import { queryKeys } from "./lib/queryKeys";
import { createAppRouter } from "./router";

async function main() {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API) {
    const { startMocks } = await import("./dev/mocks");
    await startMocks();
  }

  // A 401 on any query or mutation after we had a session means it expired: drop cached data, go to /login.
  // (Before the first successful /api/me the route guard decides: "/" → /welcome, elsewhere → /login.)
  const queryClient = createAppQueryClient(() => {
    if (queryClient.getQueryData(queryKeys.me) === undefined) return;
    queryClient.clear();
    const path = router.state.location.pathname;
    if (path !== "/login" && path !== "/welcome" && path !== "/privacy") {
      void router.navigate({ to: "/login", search: { redirect: router.state.location.href } });
    }
  });
  const router = createAppRouter(queryClient);

  const rootEl = document.getElementById("root");
  if (!rootEl) return;
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster position="top-center" richColors closeButton />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void main();
