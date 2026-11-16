// src/shared/dates.ts
import { TZDate } from "@date-fns/tz";
import { addDays as dfAddDays, differenceInCalendarDays, format, parseISO } from "date-fns";

/** Today's calendar date in an IANA timezone, as YYYY-MM-DD. */
export const todayIn = (tz: string, now: Date = new Date()): string =>
  format(new TZDate(now.getTime(), tz), "yyyy-MM-dd");
export const addDays = (isoDate: string, n: number): string =>
  format(dfAddDays(parseISO(isoDate), n), "yyyy-MM-dd");
/** a − b in calendar days. */
export const diffDays = (a: string, b: string): number =>
  differenceInCalendarDays(parseISO(a), parseISO(b));
export const minDate = (a: string, b: string): string => (a <= b ? a : b);
