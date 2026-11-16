// Spike S7 runtime half: ynab@5 and @anthropic-ai/sdk load and construct inside workerd (no network).
import { describe, expect, it } from "vitest";

describe("SDK smoke (S7)", () => {
  it("ynab SDK constructs API classes with a custom fetchApi", async () => {
    const ynab = await import("ynab");
    const cfg = new ynab.Configuration({ accessToken: "x", fetchApi: (...a: Parameters<typeof fetch>) => fetch(...a) });
    expect(new ynab.PlansApi(cfg)).toBeInstanceOf(ynab.PlansApi);
    expect(new ynab.TransactionsApi(cfg)).toBeInstanceOf(ynab.TransactionsApi);
  });
  it("Anthropic SDK constructs and exposes the zod output helper", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const client = new Anthropic({ apiKey: "sk-ant-test" });
    expect(typeof client.messages.parse).toBe("function");
    expect(typeof zodOutputFormat).toBe("function");
  });
});
