'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

// Lightweight vscode API stub to test extension.js end-to-end against a real stdio LSP stub child process.
const registered = {
  onDidChangeTextDocument: null,
  renameProvider: null,
  referenceProvider: null,
};

const docA = {
  uri: { toString: () => 'file:///proj/a.gsa' },
  languageId: 'geisha',
  version: 1,
  _text: 'pub def foo(): Int = 1\n',
  getText() { return this._text; },
};

const docB = {
  uri: { toString: () => 'file:///proj/b.gsa' },
  languageId: 'geisha',
  version: 1,
  _text: 'use a.foo\ndef main(): Int = foo()\n',
  getText() { return this._text; },
};

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start instanceof Position ? start : new Position(start, end);
    this.end = end instanceof Position ? end : new Position(arguments[2], arguments[3]);
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, newText) {
    this.edits.push({ uri: uri.toString(), range, newText });
  }
}

const vscodeStub = {
  Position,
  Range,
  Location,
  WorkspaceEdit,
  MarkdownString: class MarkdownString { constructor(v) { this.value = v; } },
  Hover: class Hover { constructor(c, r) { this.contents = c; this.range = r; } },
  DocumentSymbol: class DocumentSymbol { constructor(...a) { this.args = a; } },
  CompletionItem: class CompletionItem { constructor(l, k) { this.label = l; this.kind = k; } },
  InlayHint: class InlayHint { constructor(p, l, k) { this.position = p; this.label = l; this.kind = k; } },
  InlayHintKind: { Type: 1, Parameter: 2 },
  CodeAction: class CodeAction { constructor(t, k) { this.title = t; this.kind = k; } },
  CodeActionKind: { QuickFix: 'quickfix', Empty: '' },
  Diagnostic: class Diagnostic { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: { Function: 11 },
  CompletionItemKind: { Text: 0 },
  Uri: {
    parse: (s) => ({ toString: () => s, fsPath: s.replace(/^file:\/\//, '') }),
  },
  window: {
    createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
    showErrorMessage: () => {},
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { toString: () => 'file://' + __dirname, fsPath: __dirname } }],
    textDocuments: [docA, docB],
    getConfiguration: () => ({
      get: (k, def) => {
        if (k === 'lsp.path') return process.execPath;
        if (k === 'lsp.args') return [path.join(__dirname, 'stub_lsp_server.js')];
        if (k === 'lsp.trace') return 'off';
        return def;
      },
    }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: (cb) => { registered.onDidChangeTextDocument = cb; return { dispose: () => {} }; },
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
  },
  languages: {
    createDiagnosticCollection: () => ({ set: () => {}, clear: () => {}, dispose: () => {} }),
    registerHoverProvider: () => ({ dispose: () => {} }),
    registerDefinitionProvider: () => ({ dispose: () => {} }),
    registerReferenceProvider: (_lang, p) => { registered.referenceProvider = p; return { dispose: () => {} }; },
    registerRenameProvider: (_lang, p) => { registered.renameProvider = p; return { dispose: () => {} }; },
    registerInlayHintsProvider: () => ({ dispose: () => {} }),
    registerCodeActionsProvider: () => ({ dispose: () => {} }),
    registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: () => ({ dispose: () => {} }),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require('../extension.js');

async function main() {
  const ctx = { subscriptions: [] };
  await ext.activate(ctx);

  // 1. Simulate debounced edit on docB (insert a comment line at top, shifting `foo()` from line 1 to line 2)
  //    WITHOUT waiting 80ms, immediately invoke rename from docA!
  docB._text = '// inserted line\nuse a.foo\ndef main(): Int = foo()\n';
  docB.version = 2;
  registered.onDidChangeTextDocument({ document: docB });

  const wsEdit = await registered.renameProvider.provideRenameEdits(docA, new Position(0, 8), 'bar');
  assert(wsEdit, 'expected non-null WorkspaceEdit');
  const bEdits = wsEdit.edits.filter((e) => e.uri === 'file:///proj/b.gsa');
  assert.strictEqual(bEdits.length, 2, `expected 2 edits in docB, got ${JSON.stringify(bEdits)}`);
  // Line numbers MUST reflect the flushed docB buffer (lines 1 and 2, NOT stale 0 and 1)!
  assert.deepStrictEqual(
    bEdits.map((e) => e.range.start.line).sort((a, b) => a - b),
    [1, 2],
    `expected flushed line numbers [1, 2], got ${JSON.stringify(bEdits)}`
  );

  // 2. Also verify cross-file references flushes docB's debounced edit before requesting!
  docB._text = '// line 1\n// line 2\nuse a.foo\ndef main(): Int = foo()\n';
  docB.version = 3;
  registered.onDidChangeTextDocument({ document: docB });

  const refs = await registered.referenceProvider.provideReferences(
    docA,
    new Position(0, 8),
    { includeDeclaration: true }
  );
  const bRefLines = refs.filter((r) => r.uri.toString() === 'file:///proj/b.gsa').map((r) => r.range.start.line).sort((a, b) => a - b);
  assert.deepStrictEqual(bRefLines, [2, 3], `expected flushed ref lines [2, 3], got ${JSON.stringify(bRefLines)}`);

  // 3. Version-change guard: if docB changes while `textDocument/rename` is in flight, stale edits are discarded (returns null)
  const slowRenamePromise = registered.renameProvider.provideRenameEdits(docA, new Position(0, 8), 'slow_bar');
  await new Promise((r) => setTimeout(r, 15));
  docB.version = 4;
  const staleRes = await slowRenamePromise;
  assert.strictEqual(staleRes, null, 'expected null WorkspaceEdit when affected open document changed mid-request');

  // 4. Close-document guard: if docB is closed while `textDocument/rename` is in flight, stale edits are discarded (returns null)
  const closeRenamePromise = registered.renameProvider.provideRenameEdits(docA, new Position(0, 8), 'slow_bar');
  await new Promise((r) => setTimeout(r, 15));
  docB.isClosed = true;
  vscodeStub.workspace.textDocuments = [docA];
  const closedRes = await closeRenamePromise;
  assert.strictEqual(closedRes, null, 'expected null WorkspaceEdit when affected open document closed mid-request');

  // 5. Close + reopen guard: if docB is closed and reopened as a new document instance with the same version, stale edits are discarded
  const docB2 = {
    uri: { toString: () => 'file:///proj/b.gsa' },
    languageId: 'geisha',
    version: 1,
    isClosed: false,
    _text: 'use a.foo\ndef main(): Int = foo()\n',
    getText() { return this._text; },
  };
  vscodeStub.workspace.textDocuments = [docA, docB2];
  const reopenRenamePromise = registered.renameProvider.provideRenameEdits(docA, new Position(0, 8), 'slow_bar');
  await new Promise((r) => setTimeout(r, 15));
  const docB3 = { ...docB2 };
  vscodeStub.workspace.textDocuments = [docA, docB3];
  const reopenedRes = await reopenRenamePromise;
  assert.strictEqual(reopenedRes, null, 'expected null WorkspaceEdit when affected document was reopened mid-request');

  await ext.deactivate();
  console.log('PASS [geisha-vscode]: cross-file multi-doc debounce flush, version guard & close/reopen guard verified.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
