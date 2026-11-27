'use strict';

const cp = require('child_process');
const vscode = require('vscode');

const CHANGE_DEBOUNCE_MS = 80;

/**
 * Lightweight zero-dependency JSON-RPC 2.0 stdio client for `geisha lsp`.
 */
class GeishaLspClient {
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {string | undefined} cwd
   * @param {vscode.OutputChannel} output
   * @param {vscode.DiagnosticCollection} diagnostics
   * @param {() => string} getTrace
   */
  constructor(command, args, cwd, output, diagnostics, getTrace) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.output = output;
    this.diagnostics = diagnostics;
    this.getTrace = getTrace;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    /** @type {Map<string, { timer: NodeJS.Timeout, doc: vscode.TextDocument }>} */
    this.changeTimers = new Map();
    this.recvBuf = Buffer.alloc(0);
    this.initialized = false;
    this.disposed = false;
  }

  async start() {
    this.proc = cp.spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.output.append(`[stderr] ${chunk.toString('utf8')}`);
    });
    this.proc.on('error', (err) => {
      this.output.appendLine(`[error] Failed to start '${this.command} ${this.args.join(' ')}': ${err.message}`);
      vscode.window.showErrorMessage(
        `Failed to start Geisha Language Server (${this.command}): ${err.message}. Check the 'geisha.lsp.path' setting.`
      );
      this._rejectAll(err);
    });
    this.proc.on('exit', (code, signal) => {
      this.output.appendLine(`[exit] geisha lsp exited (code=${code}, signal=${signal})`);
      this._rejectAll(new Error(`geisha lsp exited (code=${code}, signal=${signal})`));
      this.proc = null;
      this.initialized = false;
    });

    const rootUri =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.toString()
        : null;

    await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          references: {},
          rename: { prepareSupport: true },
          inlayHint: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
            },
          },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          completion: {
            completionItem: { documentationFormat: ['markdown', 'plaintext'] },
          },
          publishDiagnostics: {},
        },
      },
    });
    this.sendNotification('initialized', {});
    this.initialized = true;

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'geisha') {
        this.didOpen(doc);
      }
    }
  }

  async stop() {
    this.disposed = true;
    this._clearAllChangeTimers();
    this.diagnostics.clear();
    if (!this.proc) return;
    try {
      await Promise.race([
        this.sendRequest('shutdown', null),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      this.sendNotification('exit', null);
    } catch (_) {
      // Ignore shutdown errors
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this._rejectAll(new Error('Client stopped'));
  }

  _clearAllChangeTimers() {
    for (const [, entry] of this.changeTimers) {
      clearTimeout(entry.timer);
    }
    this.changeTimers.clear();
  }

  _rejectAll(err) {
    for (const [, entry] of this.pending) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  _writeFrame(payload) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const json = JSON.stringify(payload);
    if (this.getTrace() !== 'off') {
      this.output.appendLine(`[send] ${json}`);
    }
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  sendNotification(method, params) {
    this._writeFrame({ jsonrpc: '2.0', method, params });
  }

  sendRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  _onStdoutData(chunk) {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    while (true) {
      const headerEnd = this.recvBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const headerText = this.recvBuf.slice(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.recvBuf = this.recvBuf.slice(headerEnd + 4);
        continue;
      }
      const contentLen = parseInt(match[1], 10);
      const totalLen = headerEnd + 4 + contentLen;
      if (this.recvBuf.length < totalLen) break;
      const bodyText = this.recvBuf.slice(headerEnd + 4, totalLen).toString('utf8');
      this.recvBuf = this.recvBuf.slice(totalLen);
      if (this.getTrace() !== 'off') {
        this.output.appendLine(`[recv] ${bodyText}`);
      }
      try {
        const msg = JSON.parse(bodyText);
        this._handleMessage(msg);
      } catch (err) {
        this.output.appendLine(`[error] Invalid JSON from server: ${err.message}`);
      }
    }
  }

  _handleMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'LSP error'));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      this._applyDiagnostics(msg.params);
    }
  }

  _applyDiagnostics(params) {
    if (!params.uri) return;
    const uri = vscode.Uri.parse(params.uri);
    const list = Array.isArray(params.diagnostics) ? params.diagnostics : [];
    const mapped = list.map((d) => {
      const range = toVsRange(d.range);
      const sev = toVsSeverity(d.severity);
      const diag = new vscode.Diagnostic(range, d.message || '', sev);
      if (d.source) diag.source = d.source;
      if (d.code !== undefined) diag.code = d.code;
      return diag;
    });
    this.diagnostics.set(uri, mapped);
  }

  didOpen(doc) {
    this.cancelPendingChange(doc.uri.toString());
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: doc.uri.toString(),
        languageId: doc.languageId,
        version: doc.version,
        text: doc.getText(),
      },
    });
  }

  didChangeNow(doc) {
    this.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: doc.uri.toString(),
        version: doc.version,
      },
      contentChanges: [{ text: doc.getText() }],
    });
  }

  scheduleDidChange(doc) {
    const key = doc.uri.toString();
    const existing = this.changeTimers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.changeTimers.delete(key);
      if (this.initialized && !this.disposed) {
        this.didChangeNow(doc);
      }
    }, CHANGE_DEBOUNCE_MS);
    this.changeTimers.set(key, { timer, doc });
  }

  flushDidChange(uriStr) {
    const entry = this.changeTimers.get(uriStr);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.changeTimers.delete(uriStr);
    if (this.initialized && !this.disposed) {
      this.didChangeNow(entry.doc);
    }
  }

  cancelPendingChange(uriStr) {
    const entry = this.changeTimers.get(uriStr);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.changeTimers.delete(uriStr);
  }

  didSave(doc) {
    this.flushDidChange(doc.uri.toString());
    this.sendNotification('textDocument/didSave', {
      textDocument: { uri: doc.uri.toString() },
      text: doc.getText(),
    });
  }

  didClose(doc) {
    this.cancelPendingChange(doc.uri.toString());
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: doc.uri.toString() },
    });
  }
}

function toVsRange(r) {
  if (!r || !r.start || !r.end) {
    return new vscode.Range(0, 0, 0, 1);
  }
  return new vscode.Range(
    new vscode.Position(r.start.line || 0, r.start.character || 0),
    new vscode.Position(r.end.line || 0, r.end.character || 0)
  );
}

function toVsSeverity(sev) {
  switch (sev) {
    case 1: return vscode.DiagnosticSeverity.Error;
    case 2: return vscode.DiagnosticSeverity.Warning;
    case 3: return vscode.DiagnosticSeverity.Information;
    case 4: return vscode.DiagnosticSeverity.Hint;
    default: return vscode.DiagnosticSeverity.Error;
  }
}

function toVsSymbolKind(k) {
  // LSP SymbolKind is 1-based; VS Code SymbolKind is 0-based.
  if (typeof k === 'number' && k >= 1 && k <= 26) {
    return k - 1;
  }
  return vscode.SymbolKind.Function;
}

function toVsDocumentSymbol(sym) {
  const ds = new vscode.DocumentSymbol(
    sym.name || '<unnamed>',
    sym.detail || '',
    toVsSymbolKind(sym.kind),
    toVsRange(sym.range),
    toVsRange(sym.selectionRange || sym.range)
  );
  if (Array.isArray(sym.children) && sym.children.length > 0) {
    ds.children = sym.children.map(toVsDocumentSymbol);
  }
  return ds;
}

function toVsCompletionKind(k) {
  // LSP CompletionItemKind is 1-based; VS Code CompletionItemKind is 0-based.
  if (typeof k === 'number' && k >= 1 && k <= 25) {
    return k - 1;
  }
  return vscode.CompletionItemKind.Text;
}

function toVsWorkspaceEdit(edit) {
  const wsEdit = new vscode.WorkspaceEdit();
  if (!edit || !edit.changes || typeof edit.changes !== 'object') {
    return wsEdit;
  }
  for (const [uriStr, textEdits] of Object.entries(edit.changes)) {
    if (!Array.isArray(textEdits)) continue;
    const uri = vscode.Uri.parse(uriStr);
    for (const te of textEdits) {
      if (!te || !te.range) continue;
      wsEdit.replace(uri, toVsRange(te.range), typeof te.newText === 'string' ? te.newText : '');
    }
  }
  return wsEdit;
}

function toLspSeverity(sev) {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error: return 1;
    case vscode.DiagnosticSeverity.Warning: return 2;
    case vscode.DiagnosticSeverity.Information: return 3;
    case vscode.DiagnosticSeverity.Hint: return 4;
    default: return 1;
  }
}

function fromVsDiagnostic(d) {
  const out = {
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    severity: toLspSeverity(d.severity),
    message: d.message || '',
  };
  if (d.source) out.source = d.source;
  if (d.code !== undefined) {
    out.code = typeof d.code === 'object' && d.code !== null ? d.code.value : d.code;
  }
  return out;
}

/** @type {GeishaLspClient | null} */
let activeClient = null;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const output = vscode.window.createOutputChannel('Geisha Language Server');
  const diagnostics = vscode.languages.createDiagnosticCollection('geisha');
  context.subscriptions.push(output, diagnostics);

  const startClient = async () => {
    if (activeClient) {
      await activeClient.stop();
      activeClient = null;
    }
    const cfg = vscode.workspace.getConfiguration('geisha');
    const cmd = cfg.get('lsp.path', 'geisha');
    const args = cfg.get('lsp.args', ['lsp']);
    const cwd =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined;
    const client = new GeishaLspClient(
      cmd,
      args,
      cwd,
      output,
      diagnostics,
      () => vscode.workspace.getConfiguration('geisha').get('lsp.trace', 'off')
    );
    activeClient = client;
    try {
      await client.start();
    } catch (err) {
      output.appendLine(`[error] Initialization failed: ${err.message}`);
    }
  };

  await startClient();

  context.subscriptions.push(
    vscode.commands.registerCommand('geisha.lsp.restart', async () => {
      output.appendLine('[info] Restarting Geisha Language Server...');
      await startClient();
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'geisha' && activeClient && activeClient.initialized) {
        activeClient.didOpen(doc);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'geisha' && activeClient && activeClient.initialized) {
        activeClient.scheduleDidChange(e.document);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'geisha' && activeClient && activeClient.initialized) {
        activeClient.didSave(doc);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === 'geisha' && activeClient && activeClient.initialized) {
        activeClient.didClose(doc);
      }
    }),
    vscode.languages.registerHoverProvider('geisha', {
      async provideHover(doc, pos) {
        if (!activeClient || !activeClient.initialized) return null;
        try {
          activeClient.flushDidChange(doc.uri.toString());
          const res = await activeClient.sendRequest('textDocument/hover', {
            textDocument: { uri: doc.uri.toString() },
            position: { line: pos.line, character: pos.character },
          });
          if (!res || !res.contents) return null;
          const value = typeof res.contents === 'string' ? res.contents : res.contents.value || '';
          const md = new vscode.MarkdownString(value);
          return new vscode.Hover(md, res.range ? toVsRange(res.range) : undefined);
        } catch (err) {
          output.appendLine(`[warn] hover request failed: ${err.message}`);
          return null;
        }
      },
    }),
    vscode.languages.registerDefinitionProvider('geisha', {
      async provideDefinition(doc, pos) {
        if (!activeClient || !activeClient.initialized) return null;
        try {
          activeClient.flushDidChange(doc.uri.toString());
          const res = await activeClient.sendRequest('textDocument/definition', {
            textDocument: { uri: doc.uri.toString() },
            position: { line: pos.line, character: pos.character },
          });
          if (!res) return null;
          if (Array.isArray(res)) {
            return res.map((loc) => new vscode.Location(vscode.Uri.parse(loc.uri), toVsRange(loc.range)));
          }
          if (res.uri && res.range) {
            return new vscode.Location(vscode.Uri.parse(res.uri), toVsRange(res.range));
          }
          return null;
        } catch (err) {
          output.appendLine(`[warn] definition request failed: ${err.message}`);
          return null;
        }
      },
    }),
    vscode.languages.registerReferenceProvider('geisha', {
      async provideReferences(doc, pos, context) {
        if (!activeClient || !activeClient.initialized) return [];
        try {
          activeClient.flushDidChange(doc.uri.toString());
          const res = await activeClient.sendRequest('textDocument/references', {
            textDocument: { uri: doc.uri.toString() },
            position: { line: pos.line, character: pos.character },
            context: { includeDeclaration: !!(context && context.includeDeclaration) },
          });
          if (!Array.isArray(res)) return [];
          return res
            .filter((loc) => loc && loc.uri && loc.range)
            .map((loc) => new vscode.Location(vscode.Uri.parse(loc.uri), toVsRange(loc.range)));
        } catch (err) {
          output.appendLine(`[warn] references request failed: ${err.message}`);
          return [];
        }
      },
    }),
    vscode.languages.registerRenameProvider('geisha', {
      async prepareRename(doc, pos) {
        if (!activeClient || !activeClient.initialized) return null;
        activeClient.flushDidChange(doc.uri.toString());
        const res = await activeClient.sendRequest('textDocument/prepareRename', {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        });
        if (!res) {
          throw new Error('Cannot rename symbol at this position');
        }
        if (res.range && typeof res.placeholder === 'string') {
          return { range: toVsRange(res.range), placeholder: res.placeholder };
        }
        if (res.start && res.end) {
          return toVsRange(res);
        }
        return null;
      },
      async provideRenameEdits(doc, pos, newName) {
        if (!activeClient || !activeClient.initialized) return null;
        activeClient.flushDidChange(doc.uri.toString());
        const res = await activeClient.sendRequest('textDocument/rename', {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
          newName,
        });
        if (!res) return null;
        return toVsWorkspaceEdit(res);
      },
    }),
    vscode.languages.registerInlayHintsProvider('geisha', {
      async provideInlayHints(doc, range) {
        if (!activeClient || !activeClient.initialized) return [];
        try {
          activeClient.flushDidChange(doc.uri.toString());
          const res = await activeClient.sendRequest('textDocument/inlayHint', {
            textDocument: { uri: doc.uri.toString() },
            range: {
              start: { line: range.start.line, character: range.start.character },
              end: { line: range.end.line, character: range.end.character },
            },
          });
          if (!Array.isArray(res)) return [];
          return res.map((h) => {
            const pos = new vscode.Position(
              (h.position && h.position.line) || 0,
              (h.position && h.position.character) || 0
            );
            const label = typeof h.label === 'string' ? h.label : '';
            const kind =
              h.kind === 1
                ? vscode.InlayHintKind.Type
                : h.kind === 2
                  ? vscode.InlayHintKind.Parameter
                  : undefined;
            const hint = new vscode.InlayHint(pos, label, kind);
            hint.paddingLeft = !!h.paddingLeft;
            hint.paddingRight = !!h.paddingRight;
            return hint;
          });
        } catch (err) {
          output.appendLine(`[warn] inlayHint request failed: ${err.message}`);
          return [];
        }
      },
    }),
    vscode.languages.registerCodeActionsProvider(
      'geisha',
      {
        async provideCodeActions(doc, range, context) {
          if (!activeClient || !activeClient.initialized) return [];
          try {
            activeClient.flushDidChange(doc.uri.toString());
            const diags = context && Array.isArray(context.diagnostics)
              ? context.diagnostics.map(fromVsDiagnostic)
              : [];
            const res = await activeClient.sendRequest('textDocument/codeAction', {
              textDocument: { uri: doc.uri.toString() },
              range: {
                start: { line: range.start.line, character: range.start.character },
                end: { line: range.end.line, character: range.end.character },
              },
              context: { diagnostics: diags },
            });
            if (!Array.isArray(res)) return [];
            return res.map((act) => {
              const kind = act.kind === 'quickfix' ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.Empty;
              const ca = new vscode.CodeAction(act.title || 'Quick Fix', kind);
              if (act.edit) {
                ca.edit = toVsWorkspaceEdit(act.edit);
              }
              return ca;
            });
          } catch (err) {
            output.appendLine(`[warn] codeAction request failed: ${err.message}`);
            return [];
          }
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.languages.registerDocumentSymbolProvider('geisha', {
      async provideDocumentSymbols(doc) {
        if (!activeClient || !activeClient.initialized) return [];
        try {
          activeClient.flushDidChange(doc.uri.toString());
          const res = await activeClient.sendRequest('textDocument/documentSymbol', {
            textDocument: { uri: doc.uri.toString() },
          });
          if (!Array.isArray(res)) return [];
          return res.map(toVsDocumentSymbol);
        } catch (err) {
          output.appendLine(`[warn] documentSymbol request failed: ${err.message}`);
          return [];
        }
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      'geisha',
      {
        async provideCompletionItems(doc, pos) {
          if (!activeClient || !activeClient.initialized) return [];
          try {
            activeClient.flushDidChange(doc.uri.toString());
            const res = await activeClient.sendRequest('textDocument/completion', {
              textDocument: { uri: doc.uri.toString() },
              position: { line: pos.line, character: pos.character },
            });
            const rawItems = Array.isArray(res) ? res : (res && Array.isArray(res.items) ? res.items : []);
            return rawItems.map((it) => {
              const ci = new vscode.CompletionItem(it.label, toVsCompletionKind(it.kind));
              if (it.detail) ci.detail = it.detail;
              if (it.documentation) {
                const docText = typeof it.documentation === 'string'
                  ? it.documentation
                  : (it.documentation.value || '');
                ci.documentation = new vscode.MarkdownString(docText);
              }
              return ci;
            });
          } catch (err) {
            output.appendLine(`[warn] completion request failed: ${err.message}`);
            return [];
          }
        },
      },
      '.'
    )
  );
}

async function deactivate() {
  if (activeClient) {
    await activeClient.stop();
    activeClient = null;
  }
}

module.exports = { activate, deactivate };
