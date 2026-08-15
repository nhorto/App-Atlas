/**
 * @fileoverview Environment and configuration reads.
 *
 * Every `process.env.X` is a value coming in from outside the code, and SPEC.md 6.6
 * asks for the full enumerable inventory: what you read, where you read it, and
 * whether you documented it in `.env.example`. That last comparison is the one that
 * catches the classic "works on my machine, missing in production" failure.
 */
import { Node } from 'ts-morph';
import { dottedName, literalString, objectProp } from './ast.js';
const ENV_OBJECTS = new Set(['process.env', 'import.meta.env']);
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const envDetector = {
    id: 'env',
    enabled: () => true,
    visit(node, ctx) {
        if (Node.isPropertyAccessExpression(node)) {
            if (ENV_OBJECTS.has(node.getExpression().getText()))
                emit(node.getName(), node, ctx);
            return;
        }
        if (Node.isElementAccessExpression(node)) {
            if (!ENV_OBJECTS.has(node.getExpression().getText()))
                return;
            const name = literalString(node.getArgumentExpression());
            if (name)
                emit(name, node, ctx);
            return;
        }
        // `const { STRIPE_KEY, DATABASE_URL } = process.env`
        if (Node.isVariableDeclaration(node)) {
            const init = node.getInitializer();
            const name = node.getNameNode();
            if (!init || !Node.isObjectBindingPattern(name))
                return;
            if (!ENV_OBJECTS.has(init.getText()))
                return;
            for (const element of name.getElements()) {
                emit(element.getPropertyNameNode()?.getText() ?? element.getName(), element, ctx);
            }
            return;
        }
        if (Node.isCallExpression(node)) {
            const dotted = dottedName(node.getExpression());
            if (!dotted)
                return;
            // Deno and Bun read the environment through a function.
            if (dotted === 'Deno.env.get' || dotted === 'Bun.env.get') {
                const name = literalString(node.getArguments()[0]);
                if (name)
                    emit(name, node, ctx);
                return;
            }
            // A typed env schema (`@t3-oss/env-*`, envalid) declares the whole set at once,
            // which is the best possible source: it is the author's own list.
            if (dotted === 'createEnv' || dotted === 'cleanEnv') {
                const config = node.getArguments()[dotted === 'cleanEnv' ? 1 : 0];
                for (const group of ['server', 'client', 'shared']) {
                    collectKeys(objectProp(config, group), node, ctx);
                }
                if (dotted === 'cleanEnv')
                    collectKeys(config, node, ctx);
            }
        }
    },
};
function collectKeys(obj, at, ctx) {
    if (!obj || !Node.isObjectLiteralExpression(obj))
        return;
    for (const prop of obj.getProperties()) {
        if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
            emit(prop.getName().replace(/^['"]|['"]$/g, ''), at, ctx);
        }
    }
}
function emit(name, at, ctx) {
    if (!VALID_NAME.test(name))
        return;
    ctx.emit({ type: 'env', name, site: ctx.site(at, `${name}`) });
}
//# sourceMappingURL=env.js.map