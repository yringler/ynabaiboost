import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WelcomePage } from "../../src/client/routes/welcome";

describe("client scaffold", () => {
  it("renders the welcome placeholder", () => {
    const { container } = render(<WelcomePage />);
    expect(container.querySelector(".landing")).not.toBeNull();
    expect(screen.getByText("Hero")).toBeTruthy();
  });
});
