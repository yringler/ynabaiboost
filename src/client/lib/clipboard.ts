// lib/clipboard.ts — WP6: copy with a toast (used for the user id on /login and /settings).
import { toast } from "sonner";

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Copy failed. Select the text and copy it.");
  }
}
