import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftEditor } from "../../src/client/components/DraftEditor";
import { draftToState, type DraftState } from "../../src/client/lib/draft";

const catalog = {
  currency: { isoCode: "USD", decimalDigits: 2 },
  categories: [
    { id: "c1", groupId: "g", groupName: "Fun", name: "Electronics" },
    { id: "c2", groupId: "g", groupName: "Fun", name: "Books" },
  ],
  accounts: [
    { id: "a1", name: "Visa", type: "creditCard", onBudget: true, closed: false, directImportLinked: true },
    { id: "a2", name: "Wallet", type: "cash", onBudget: true, closed: false, directImportLinked: false },
  ],
  payees: [{ id: "p1", name: "Amazon" }],
  recentCategoryIds: ["c2"],
};

const initial = draftToState({
  payee: "Amazon", payeeId: "p1", merchantKind: "amazon", direction: "outflow", date: "2026-11-16", accountId: null,
  accountExplicit: false, totalAmount: 35_000, approximate: false, memo: null,
  lines: [
    { description: "case", categoryId: "c1", amount: 20_000, approximate: false, confidence: null },
    { description: "book", categoryId: "c2", amount: 15_000, approximate: false, confidence: "low" },
  ],
}, 2, true);

function Harness({ start = initial }: { start?: DraftState }) {
  const [d, setD] = useState(start);
  return <DraftEditor draft={d} onChange={setD} catalog={catalog} placeholdersEnabled />;
}

afterEach(cleanup);

describe("DraftEditor", () => {
  it("shows the live line sum and flags a mismatch", () => {
    render(<Harness />);
    const sum = screen.getByTestId("line-sum");
    expect(sum.textContent).toMatch(/\$35\.00 of \$35\.00/);
    expect(sum.className).toMatch(/text-ok/);

    const amounts = screen.getAllByLabelText("Item amount");
    fireEvent.change(amounts[1] as HTMLElement, { target: { value: "10" } });
    expect(screen.getByTestId("line-sum").textContent).toMatch(/\$30\.00 of \$35\.00/);
    expect(screen.getByTestId("line-sum").className).toMatch(/text-destructive/);

    fireEvent.click(screen.getByRole("button", { name: "Use item sum as total" }));
    expect((screen.getByLabelText("Total") as HTMLInputElement).value).toBe("30.00");
    expect(screen.getByTestId("line-sum").className).toMatch(/text-ok/);
  });

  it("marks low-confidence categories and new payees", () => {
    render(<Harness />);
    expect(screen.getByLabelText(/Category: Books \(unsure\)/)).toBeTruthy();
    expect(screen.queryByText("new payee")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Payee/), { target: { value: "Corner shop" } });
    expect(screen.getByText("new payee")).toBeTruthy();
  });

  it("adding an item to a single-line draft carries the total into the first line", () => {
    const single = { ...initial, lines: [initial.lines[0]!].map((l) => ({ ...l, amountText: "" })) };
    render(<Harness start={single} />);
    expect(screen.queryAllByLabelText("Item amount")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Add item/ }));
    const amounts = screen.getAllByLabelText("Item amount") as HTMLInputElement[];
    expect(amounts).toHaveLength(2);
    expect(amounts[0]?.value).toBe("35.00");
  });
});
