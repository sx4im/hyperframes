/**
 * Resolve the composition-variable values an element should see: the scoped
 * per-instance table for inlined sub-compositions, then the top-level merged
 * getVariables(), then the raw render-injection global. Shared by every
 * runtime consumer of variables (color grading, declarative bindings) so the
 * scope chain can never diverge between channels.
 */

type VariablesWindow = Window & {
  __hfVariables?: Record<string, unknown>;
  __hfVariablesByComp?: Record<string, Record<string, unknown>>;
  __hyperframes?: { getVariables?: () => Record<string, unknown> };
};

/** The per-instance values of the inlined sub-composition an element belongs to, if any. */
export function scopedVariablesFor(element: Element): Record<string, unknown> | undefined {
  const byComp = (window as VariablesWindow).__hfVariablesByComp;
  if (!byComp) return undefined;
  const compositionId = nearestTableScopeId(element, byComp);
  return compositionId ? byComp[compositionId] : undefined;
}

/** Nearest enclosing scope id the table knows: an inner root keeps its declared id while the table is keyed by the mount's runtime id. */
function nearestTableScopeId(
  element: Element,
  byComp: Record<string, Record<string, unknown>>,
): string | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const compositionId = node.getAttribute("data-composition-id")?.trim() ?? "";
    if (compositionId && byComp[compositionId]) return compositionId;
  }
  return undefined;
}

export function readVariablesForElement(element: Element): Record<string, unknown> {
  const win = window as VariablesWindow;
  const scoped = scopedVariablesFor(element);
  if (scoped) return scoped;
  const fromHelper = win.__hyperframes?.getVariables?.();
  if (fromHelper && typeof fromHelper === "object") {
    return fromHelper;
  }
  return win.__hfVariables ?? {};
}
