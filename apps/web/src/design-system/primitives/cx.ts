/** Joins class names, dropping falsy values. Kept local to the design system (no cross-import from `ui/`). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
