import { describe, expect, it } from "vitest";
import { addDays, diffDays, minDate, todayIn } from "../../src/shared/dates";

describe("dates", () => {
  it("todayIn resolves the calendar date in a timezone", () => {
    const now = new Date("2026-11-16T07:30:00Z");
    expect(todayIn("UTC", now)).toBe("2026-11-16");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-11-15");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-11-16");
  });
  it("todayIn across DST transitions", () => {
    // US DST ends 2026-11-01 at 02:00 local (09:00Z PST start). 06:30Z is 23:30 PDT on Oct 31.
    expect(todayIn("America/Los_Angeles", new Date("2026-11-01T06:30:00Z"))).toBe("2026-10-31");
    expect(todayIn("America/Los_Angeles", new Date("2026-11-01T07:30:00Z"))).toBe("2026-11-01");
    // US DST starts 2026-03-08. 07:59Z is 23:59 PST on Mar 7; 08:00Z is 00:00 PST on Mar 8.
    expect(todayIn("America/Los_Angeles", new Date("2026-03-08T07:59:00Z"))).toBe("2026-03-07");
    expect(todayIn("America/Los_Angeles", new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    // Europe DST ends 2026-10-25.
    expect(todayIn("Europe/Berlin", new Date("2026-10-25T22:30:00Z"))).toBe("2026-10-25");
    expect(todayIn("Europe/Berlin", new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
  });
  it("addDays crosses months, years and DST without drift", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-11-16", -120)).toBe("2026-07-19");
  });
  it("diffDays is a − b in calendar days", () => {
    expect(diffDays("2026-11-17", "2026-11-16")).toBe(1);
    expect(diffDays("2026-11-14", "2026-11-16")).toBe(-2);
    expect(diffDays("2026-03-09", "2026-03-07")).toBe(2);
  });
  it("minDate", () => {
    expect(minDate("2026-11-16", "2026-11-17")).toBe("2026-11-16");
    expect(minDate("2026-12-01", "2026-11-17")).toBe("2026-11-17");
  });
});
