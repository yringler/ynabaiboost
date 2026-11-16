// domain/memo.ts — WP5 (DESIGN §10.8). PURE. Stub created by WP1; signatures are WP5-internal (not frozen).
/** "[aib:XXXXXX]" */
export function memoTag(_shortRef: string): string {
  throw new Error("not implemented: memoTag");
}
export function hasTag(_memo: string | null, _shortRef: string): boolean {
  throw new Error("not implemented: hasTag");
}
/** Never exceeds 500 chars; never drops user text. */
export function mergeMemo(_existing: string | null, _addition: string | null, _tag: string): string {
  throw new Error("not implemented: mergeMemo");
}
