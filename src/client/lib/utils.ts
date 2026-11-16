// lib/utils.ts — shadcn/ui `cn` helper (WP6 owns; created by WP1 so generated components compile).
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
