import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";

export interface MediaSrcMutation {
  selector: string;
  operation: "src_assignment" | "set_attribute";
  raw: string;
}

interface Binding {
  initializer: acorn.Expression | null;
  scope: Scope;
}

interface Scope {
  parent?: Scope;
  bindings: Map<string, Binding>;
}

function parseProgram(script: string): acorn.Program {
  try {
    return acorn.parse(script, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return acorn.parse(script, { ecmaVersion: "latest", sourceType: "module" });
  }
}

function literalString(node: acorn.AnyNode | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function memberName(node: acorn.AnyNode | null | undefined): string | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return literalString(node.property);
}

function isFunctionScope(node: acorn.AnyNode): boolean {
  return (
    node.type === "Program" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "StaticBlock"
  );
}

function isScope(node: acorn.AnyNode): boolean {
  return (
    isFunctionScope(node) ||
    node.type === "BlockStatement" ||
    node.type === "CatchClause" ||
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "SwitchStatement" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  );
}

function declarePattern(
  pattern: acorn.Pattern,
  initializer: acorn.Expression | null,
  scope: Scope,
  initializerScope = scope,
): void {
  switch (pattern.type) {
    case "Identifier":
      if (initializer || !scope.bindings.has(pattern.name)) {
        scope.bindings.set(pattern.name, { initializer, scope: initializerScope });
      }
      break;
    case "RestElement":
      declarePattern(pattern.argument, null, scope);
      break;
    case "AssignmentPattern":
      declarePattern(pattern.left, null, scope);
      break;
    case "ArrayPattern":
    case "ObjectPattern":
      declarePatterns(destructuredPatterns(pattern), scope);
      break;
  }
}

function declarePatterns(patterns: readonly acorn.Pattern[], scope: Scope): void {
  for (const pattern of patterns) declarePattern(pattern, null, scope);
}

function destructuredPatterns(pattern: acorn.ObjectPattern | acorn.ArrayPattern): acorn.Pattern[] {
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.map((property) =>
      property.type === "RestElement" ? property.argument : property.value,
    );
  }
  return pattern.elements.filter((element): element is acorn.Pattern => element !== null);
}

function declareOptionalPattern(pattern: acorn.Pattern | null | undefined, scope: Scope): void {
  if (pattern) declarePattern(pattern, null, scope);
}

function declareScopedName(node: acorn.AnyNode, scope: Scope): void {
  switch (node.type) {
    case "FunctionExpression":
    case "FunctionDeclaration":
      declareOptionalPattern(node.id, scope);
      declarePatterns(node.params, scope);
      break;
    case "ArrowFunctionExpression":
      declarePatterns(node.params, scope);
      break;
    case "ClassDeclaration":
    case "ClassExpression":
      declareOptionalPattern(node.id, scope);
      break;
    case "CatchClause":
      declareOptionalPattern(node.param, scope);
      break;
    case "ImportDeclaration":
      declarePatterns(
        node.specifiers.map((specifier) => specifier.local),
        scope,
      );
      break;
  }
}

function lookupBinding(name: string, scope: Scope): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function collectBindings(
  ast: acorn.Program,
): (ancestors: readonly acorn.AnyNode[], functionOnly?: boolean) => Scope {
  const root: Scope = { bindings: new Map() };
  const scopes = new WeakMap<acorn.AnyNode, Scope>([[ast, root]]);
  const scopeAt = (ancestors: readonly acorn.AnyNode[], functionOnly = false): Scope => {
    let parent = root;
    let selected = root;
    for (const node of ancestors) {
      if (!isScope(node)) continue;
      let scope = scopes.get(node);
      if (!scope) {
        scope = { parent, bindings: new Map() };
        scopes.set(node, scope);
      }
      parent = scope;
      if (!functionOnly || isFunctionScope(node)) selected = scope;
    }
    return selected;
  };

  acornWalk.fullAncestor(ast, (node, _state, ancestors) => {
    const scope = scopeAt(ancestors);
    if (node.type === "VariableDeclarator") {
      const declaration = ancestors.at(-2);
      const bindingScope = scopeAt(
        ancestors,
        declaration?.type === "VariableDeclaration" && declaration.kind === "var",
      );
      declarePattern(node.id, node.init ?? null, bindingScope, scope);
      return;
    }
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      declarePattern(node.id, null, scopeAt(ancestors.slice(0, -1)));
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      memberName(node.callee) === "forEach"
    ) {
      // `querySelectorAll(...).forEach((el) => { el.src = ... })`: the callback
      // parameter is an element of the list, so bind it to the selector call.
      // declarePattern only overwrites a binding with a non-null initializer,
      // so this survives the callback's own parameter declaration below.
      const source = querySelectorAllSource(node.callee.object, scope);
      const callback = node.arguments[0];
      if (
        source &&
        callback &&
        (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression") &&
        callback.params[0]?.type === "Identifier"
      ) {
        declarePattern(callback.params[0], source, scopeAt([...ancestors, node, callback]));
      }
    }
    if (node.type === "ForOfStatement") {
      // `for (const el of document.querySelectorAll(...))`: the loop variable
      // is an element of the list. A for-of declarator carries no initializer
      // (it lives on the statement's `right`), so bind it here; the later
      // declarator visit with a null initializer does not overwrite it.
      const source = querySelectorAllSource(node.right, scope);
      const declaration = node.left;
      const declarator =
        declaration.type === "VariableDeclaration" ? declaration.declarations[0] : undefined;
      if (source && declarator?.id.type === "Identifier") {
        declarePattern(declarator.id, source, scopeAt([...ancestors, node]));
      }
    }
    declareScopedName(node, scope);
  });
  return scopeAt;
}

function lookupSelector(
  node: acorn.Expression | acorn.Super | null | undefined,
  scope: Scope,
  seen = new Set<Binding>(),
): string | undefined {
  if (node?.type === "Identifier") {
    const binding = lookupBinding(node.name, scope);
    if (!binding || seen.has(binding)) return undefined;
    seen.add(binding);
    return lookupSelector(binding.initializer, binding.scope, seen);
  }
  return selectorFromDomLookup(node);
}

function selectorFromDomLookup(
  node: acorn.Expression | acorn.Super | null | undefined,
): string | undefined {
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression") {
    return undefined;
  }
  const method = memberName(node.callee);
  // querySelectorAll resolves to its selector too: a write to an element drawn
  // from the list (a forEach callback parameter, a for-of variable) targets
  // every element the selector matches, so the selector is the right target.
  if (method !== "getElementById" && method !== "querySelector" && method !== "querySelectorAll")
    return undefined;
  const value = literalString(node.arguments[0]);
  if (!value) return undefined;
  return method === "getElementById" ? `#${value}` : value;
}

/**
 * Resolve an expression to the `querySelectorAll(...)` call whose elements it
 * yields: the call itself, a variable (or alias chain) holding it, or a
 * `Array.from(...)` / spread copy of it. Returns undefined for anything else
 * (notably a bare function parameter, which has no selector to resolve to).
 */
function querySelectorAllSource(
  node: acorn.Expression | acorn.Super | acorn.SpreadElement | null | undefined,
  scope: Scope,
  seen = new Set<Binding>(),
): acorn.CallExpression | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") {
    const binding = lookupBinding(node.name, scope);
    if (!binding || seen.has(binding)) return undefined;
    seen.add(binding);
    return querySelectorAllSource(binding.initializer, binding.scope, seen);
  }
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const method = memberName(node.callee);
    if (method === "querySelectorAll") return node;
    if (
      method === "from" &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Array"
    ) {
      const first = node.arguments[0];
      if (first && first.type !== "SpreadElement") {
        return querySelectorAllSource(first, scope, seen);
      }
    }
    return undefined;
  }
  if (node.type === "ArrayExpression" && node.elements.length === 1) {
    const only = node.elements[0];
    if (only?.type === "SpreadElement") {
      return querySelectorAllSource(only.argument, scope, seen);
    }
  }
  return undefined;
}

/**
 * Find literal source writes whose target is a statically resolvable DOM
 * lookup. That includes writes to a `querySelectorAll` loop variable, which
 * resolves to the loop's selector (see `querySelectorAllSource`).
 */
export function extractMediaSrcMutations(script: string): MediaSrcMutation[] {
  try {
    const ast = parseProgram(script);
    const scopeAt = collectBindings(ast);
    const mutations: MediaSrcMutation[] = [];
    acornWalk.ancestor(ast, {
      AssignmentExpression(node, _state, ancestors) {
        if (
          node.operator !== "=" ||
          node.left.type !== "MemberExpression" ||
          memberName(node.left) !== "src"
        )
          return;
        const selector = lookupSelector(node.left.object, scopeAt(ancestors));
        if (!selector) return;
        mutations.push({
          selector,
          operation: "src_assignment",
          raw: script.slice(node.start, node.end),
        });
      },
      CallExpression(node, _state, ancestors) {
        if (node.callee.type !== "MemberExpression" || memberName(node.callee) !== "setAttribute")
          return;
        if (literalString(node.arguments[0])?.toLowerCase() !== "src") return;
        const selector = lookupSelector(node.callee.object, scopeAt(ancestors));
        if (!selector) return;
        mutations.push({
          selector,
          operation: "set_attribute",
          raw: script.slice(node.start, node.end),
        });
      },
    });
    return mutations;
  } catch {
    return [];
  }
}
