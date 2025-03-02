import { declare } from "@babel/helper-plugin-utils";
import { types as t } from "@babel/core";
import {
  DestructuringTransformer,
  convertVariableDeclaration,
  convertAssignmentExpression,
} from "./util";

/**
 * Test if a VariableDeclaration's declarations contains any Patterns.
 */

function variableDeclarationHasPattern(node: t.VariableDeclaration) {
  for (const declar of node.declarations) {
    if (t.isPattern(declar.id)) {
      return true;
    }
  }
  return false;
}

export interface Options {
  allowArrayLike?: boolean;
  loose?: boolean;
  useBuiltIns?: boolean;
}

export default declare((api, options: Options) => {
  api.assertVersion(7);

  const { useBuiltIns = false } = options;

  const iterableIsArray = (api.assumption("iterableIsArray") ??
    options.loose ??
    false) as boolean;
  const arrayLikeIsIterable = (options.allowArrayLike ??
    api.assumption("arrayLikeIsIterable") ??
    false) as boolean;
  const objectRestNoSymbols = (api.assumption("objectRestNoSymbols") ??
    options.loose ??
    false) as boolean;

  return {
    name: "transform-destructuring",

    visitor: {
      ExportNamedDeclaration(path) {
        const declaration = path.get("declaration");
        if (!declaration.isVariableDeclaration()) return;
        if (!variableDeclarationHasPattern(declaration.node)) return;

        const specifiers = [];

        for (const name of Object.keys(path.getOuterBindingIdentifiers())) {
          specifiers.push(
            t.exportSpecifier(t.identifier(name), t.identifier(name)),
          );
        }

        // Split the declaration and export list into two declarations so that the variable
        // declaration can be split up later without needing to worry about not being a
        // top-level statement.
        path.replaceWith(declaration.node);
        path.insertAfter(t.exportNamedDeclaration(null, specifiers));
        path.scope.crawl();
      },

      ForXStatement(path) {
        const { node, scope } = path;
        const left = node.left;

        if (t.isPattern(left)) {
          // for ({ length: k } in { abc: 3 });

          const temp = scope.generateUidIdentifier("ref");

          node.left = t.variableDeclaration("var", [
            t.variableDeclarator(temp),
          ]);

          path.ensureBlock();
          const statementBody = (node.body as t.BlockStatement).body;

          if (statementBody.length === 0 && path.isCompletionRecord()) {
            statementBody.unshift(
              t.expressionStatement(scope.buildUndefinedNode()),
            );
          }

          statementBody.unshift(
            t.expressionStatement(t.assignmentExpression("=", left, temp)),
          );

          scope.crawl();
          return;
        }

        if (!t.isVariableDeclaration(left)) return;

        const pattern = left.declarations[0].id;
        if (!t.isPattern(pattern)) return;

        const key = scope.generateUidIdentifier("ref");
        node.left = t.variableDeclaration(left.kind, [
          t.variableDeclarator(key, null),
        ]);

        const nodes = [];

        const destructuring = new DestructuringTransformer({
          kind: left.kind,
          scope: scope,
          nodes: nodes,
          arrayLikeIsIterable,
          iterableIsArray,
          objectRestNoSymbols,
          useBuiltIns,
          addHelper: name => this.addHelper(name),
        });

        destructuring.init(pattern, key);

        path.ensureBlock();

        const block = node.body;
        // @ts-expect-error: ensureBlock ensures that node.body is a BlockStatement
        block.body = nodes.concat(block.body);
        scope.crawl();
      },

      CatchClause({ node, scope }) {
        const pattern = node.param;
        if (!t.isPattern(pattern)) return;

        const ref = scope.generateUidIdentifier("ref");
        node.param = ref;

        const nodes = [];

        const destructuring = new DestructuringTransformer({
          kind: "let",
          scope: scope,
          nodes: nodes,
          arrayLikeIsIterable,
          iterableIsArray,
          objectRestNoSymbols,
          useBuiltIns,
          addHelper: name => this.addHelper(name),
        });
        destructuring.init(pattern, ref);

        node.body.body = nodes.concat(node.body.body);
        scope.crawl();
      },

      AssignmentExpression(path, state) {
        if (!t.isPattern(path.node.left)) return;
        convertAssignmentExpression(
          path,
          name => state.addHelper(name),
          arrayLikeIsIterable,
          iterableIsArray,
          objectRestNoSymbols,
          useBuiltIns,
        );
      },

      VariableDeclaration(path, state) {
        const { node, parent } = path;
        if (t.isForXStatement(parent)) return;
        if (!parent || !path.container) return; // i don't know why this is necessary - TODO
        if (!variableDeclarationHasPattern(node)) return;
        convertVariableDeclaration(
          path,
          name => state.addHelper(name),
          arrayLikeIsIterable,
          iterableIsArray,
          objectRestNoSymbols,
          useBuiltIns,
        );
      },
    },
  };
});
