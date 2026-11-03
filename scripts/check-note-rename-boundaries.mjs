#!/usr/bin/env node
import ts from 'typescript';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_ROOT = resolve(REPO_ROOT, 'app/flowix-web');
const ALLOWED_RENAME_CALLER = 'features/document/use-cases/local-document-operations.ts';
const ALLOWED_RENAME_COMMAND_CALLER = 'platform/tauri/client/desktop.ts';
const RAW_RENAME_COMMANDS = new Set(['rename_file', 'rename_memo_title']);
const PROTECTED_RENAME_IMPORTS = new Map([
  ['renameLocalDocumentFile', new Set(['features/workspace/use-cases/rename-workspace-file.ts'])],
  // 直接调用方的允许名单。改名编排抽成 hook 后，名单必须跟着调用点走：
  // 文件树 / 表格的改名逻辑现在分别在 use-notebook-tree-rename.ts 与
  // use-table-note-linking.ts，壳组件（notebook-file-tree / table-document-view）
  // 已不再直接引用，留着旧路径只会让真正的调用方漏检。
  ['renameMarkdownTitle', new Set([
    'features/document/components/document-container.tsx',
    'features/memo/components/memo-card.tsx',
    'features/memo/components/use-notebook-tree-rename.ts',
    'features/multidimensional-table/use-table-note-linking.ts',
  ])],
]);

const slash = (path) => path.replaceAll('\\', '/');
const relativeTo = (root, path) => slash(relative(root, path));
const isTestFile = (path) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);

function getPropertySymbol(checker, expression, propertyName) {
  const type = checker.getTypeAtLocation(expression);
  return checker.getPropertyOfType(type, propertyName);
}

function resolvesToRawRename(symbol, allowedDefinition, webRoot) {
  if (!symbol) return false;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try { symbol = symbol.getAliasedSymbol(); } catch { return false; }
  }
  if (symbol.getName() !== 'rename') return false;
  return (symbol.getDeclarations() ?? []).some((declaration) =>
    relativeTo(webRoot, declaration.getSourceFile().fileName) === allowedDefinition,
  );
}

function isRenameApiModule(moduleName) {
  return /(?:^|\/)(?:local-document-operations|file-operations-api)$/.test(moduleName);
}

export function checkNoteRenameBoundaries({ repoRoot = REPO_ROOT, webRoot = WEB_ROOT } = {}) {
  const configPath = resolve(repoRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot, undefined, configPath);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const violations = [];
  const rawRenameDefinition = 'platform/tauri/client/desktop.ts';
  const allowedRenameDefinition = relativeTo(webRoot, resolve(webRoot, rawRenameDefinition));

  for (const sourceFile of program.getSourceFiles()) {
    const path = resolve(sourceFile.fileName);
    if (!path.startsWith(`${webRoot}/`) || isTestFile(path)) continue;
    const file = relativeTo(webRoot, path);
    const allowedCaller = file === ALLOWED_RENAME_CALLER;
    const allowedCommandCaller = file === ALLOWED_RENAME_COMMAND_CALLER;

    const visit = (node) => {
      if (ts.isImportSpecifier(node)) {
        const importedName = node.propertyName?.text ?? node.name.text;
        const allowedFiles = PROTECTED_RENAME_IMPORTS.get(importedName);
        const importDeclaration = node.parent.parent.parent;
        const moduleName = ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)
          ? importDeclaration.moduleSpecifier.text : '';
        if (allowedFiles && isRenameApiModule(moduleName) && !allowedFiles.has(file)) {
          violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${importedName} must be called through its approved rename adapter`);
        }
      } else if (ts.isNamespaceImport(node)) {
        const importDeclaration = node.parent.parent;
        const moduleName = ts.isImportDeclaration(importDeclaration) && ts.isStringLiteral(importDeclaration.moduleSpecifier)
          ? importDeclaration.moduleSpecifier.text : '';
        if (isRenameApiModule(moduleName) && file !== 'features/workspace/use-cases/rename-workspace-file.ts') {
          violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: namespace access to the protected rename API is only allowed in the workspace rename adapter`);
        }
      }

      if (ts.isPropertyAccessExpression(node) && node.name.text === 'rename') {
        if (resolvesToRawRename(getPropertySymbol(checker, node.expression, 'rename'), allowedRenameDefinition, webRoot)
          && !allowedCaller) {
          violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: files.rename must go through the protected document rename use case`);
        }
      } else if (ts.isElementAccessExpression(node)
        && node.argumentExpression
        && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === 'rename') {
        if (resolvesToRawRename(getPropertySymbol(checker, node.expression, 'rename'), allowedRenameDefinition, webRoot)
          && !allowedCaller) {
          violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: bracket access to files.rename must go through the protected document rename use case`);
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const declaration = node.parent.parent;
        const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
        const property = node.propertyName ?? node.name;
        if (initializer && ts.isIdentifier(property) && property.text === 'rename'
          && resolvesToRawRename(getPropertySymbol(checker, initializer, property.text), allowedRenameDefinition, webRoot)
          && !allowedCaller) {
          violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: destructuring files.rename must go through the protected document rename use case`);
        }
      }

      if (ts.isStringLiteralLike(node) && RAW_RENAME_COMMANDS.has(node.text)
        && (node.text !== 'rename_file' || !allowedCommandCaller)) {
        violations.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: raw rename IPC command ${node.text} is only allowed in the desktop adapter`);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkNoteRenameBoundaries();
  if (violations.length) {
    console.error(`Protected note rename boundary violations (${violations.length}):\n${violations.map((item) => `- ${item}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Protected note rename boundary check passed.');
  }
}
