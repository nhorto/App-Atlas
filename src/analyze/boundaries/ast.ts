/**
 * @fileoverview Small syntax helpers shared by every detector.
 *
 * Boundary detection is mostly a matter of recognising shapes — `x.y.z(...)` with a
 * string literal in the first argument — so these helpers exist to keep the detectors
 * readable rather than to do anything clever.
 */
import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, ObjectLiteralExpression } from 'ts-morph';

/** `a.b.c` for an identifier or property-access chain; null for anything else. */
export function dottedName(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isThisExpression(node)) return 'this';
  if (Node.isPropertyAccessExpression(node)) {
    const left = dottedName(node.getExpression());
    return left ? `${left}.${node.getName()}` : null;
  }
  if (Node.isElementAccessExpression(node)) {
    const left = dottedName(node.getExpression());
    const key = literalString(node.getArgumentExpression());
    return left && key ? `${left}.${key}` : left;
  }
  // `db.select().from(x)` — look through the call so the chain stays readable.
  if (Node.isCallExpression(node)) return dottedName(node.getExpression());
  if (Node.isNonNullExpression(node) || Node.isParenthesizedExpression(node)) {
    return dottedName(node.getExpression());
  }
  if (Node.isAwaitExpression(node)) return dottedName(node.getExpression());
  return null;
}

/** The leftmost identifier of a chain: `prisma` in `prisma.user.findMany()`. */
export function rootName(node: Node | undefined): string | null {
  const dotted = dottedName(node);
  return dotted ? dotted.split('.')[0] : null;
}

/** The string a node evaluates to, when that is knowable without running anything. */
export function literalString(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return literalString(node.getExpression());
  }
  return null;
}

/**
 * The fixed prefix of a template literal: `https://api.stripe.com/v1/` from
 * `` `https://api.stripe.com/v1/${id}` ``. Enough to recover the hostname, which is
 * the part the boundary view cares about.
 */
export function literalPrefix(node: Node | undefined): string | null {
  const exact = literalString(node);
  if (exact) return exact;
  if (node && Node.isTemplateExpression(node)) {
    const head = node.getHead().getLiteralText();
    return head.length > 0 ? head : null;
  }
  return null;
}

export function argAt(call: CallExpression, index: number): Node | undefined {
  return call.getArguments()[index];
}

/** The initializer of one property of an object literal, by name. */
export function objectProp(obj: Node | undefined, name: string): Node | undefined {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  const prop = (obj as ObjectLiteralExpression).getProperty(name);
  if (!prop) return undefined;
  if (Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  return undefined;
}

/** Every string literal in an array literal (or the single string, if it is one). */
export function stringArray(node: Node | undefined): string[] {
  if (!node) return [];
  const single = literalString(node);
  if (single) return [single];
  if (Node.isArrayLiteralExpression(node)) {
    return node
      .getElements()
      .map((el) => literalString(el))
      .filter((s): s is string => Boolean(s));
  }
  return [];
}

/** Does this call take a function as one of its arguments, and which one. */
export function functionArg(call: CallExpression): Node | undefined {
  const args = call.getArguments();
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg) || Node.isIdentifier(arg)) return arg;
  }
  return undefined;
}

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. Relative paths pass through. */
export function packageRoot(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return specifier;
  const clean = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const parts = clean.split('/');
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
}

/** True when a function-ish node's body opens with the given directive. */
export function hasDirective(node: Node, directive: string): boolean {
  const body = Node.isBlock(node)
    ? node
    : (node.getFirstChildByKind(SyntaxKind.Block) ?? undefined);
  const statements = body && Node.isBlock(body) ? body.getStatements() : [];
  for (const statement of statements.slice(0, 2)) {
    if (!Node.isExpressionStatement(statement)) break;
    if (literalString(statement.getExpression()) === directive) return true;
  }
  return false;
}

/** The first line of a node, collapsed — enough to show as evidence without a wall of code. */
export function snippetOf(node: Node, max = 120): string {
  const text = node.getText().split('\n')[0].replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
