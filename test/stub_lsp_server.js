'use strict';

// Minimal JSON-RPC 2.0 stdio stub LSP server for testing multi-document debounce flush & version guard.
const docs = new Map();
let recvBuf = Buffer.alloc(0);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  process.stdout.write(Buffer.concat([header, body]));
}

function findFooLocations() {
  const locs = [];
  for (const [uri, text] of docs.entries()) {
    const lines = text.split('\n');
    for (let l = 0; l < lines.length; l++) {
      const idx = lines[l].indexOf('foo');
      if (idx >= 0) {
        locs.push({
          uri,
          range: {
            start: { line: l, character: idx },
            end: { line: l, character: idx + 3 },
          },
        });
      }
    }
  }
  return locs;
}

function handleMsg(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          referencesProvider: true,
          renameProvider: { prepareProvider: true },
        },
      },
    });
  } else if (msg.method === 'textDocument/didOpen') {
    docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
  } else if (msg.method === 'textDocument/didChange') {
    const changes = msg.params.contentChanges || [];
    if (changes.length > 0) {
      docs.set(msg.params.textDocument.uri, changes[changes.length - 1].text);
    }
  } else if (msg.method === 'textDocument/references') {
    send({ jsonrpc: '2.0', id: msg.id, result: findFooLocations() });
  } else if (msg.method === 'textDocument/rename') {
    const newName = msg.params.newName;
    const respond = () => {
      const changes = {};
      for (const loc of findFooLocations()) {
        if (!changes[loc.uri]) changes[loc.uri] = [];
        changes[loc.uri].push({ range: loc.range, newText: newName });
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { changes } });
    };
    if (newName === 'slow_bar') {
      setTimeout(respond, 60);
    } else {
      respond();
    }
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}

process.stdin.on('data', (chunk) => {
  recvBuf = Buffer.concat([recvBuf, chunk]);
  while (true) {
    const headerEnd = recvBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const headerText = recvBuf.slice(0, headerEnd).toString('ascii');
    const m = /content-length:\s*(\d+)/i.exec(headerText);
    if (!m) {
      recvBuf = recvBuf.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (recvBuf.length < total) break;
    const body = recvBuf.slice(headerEnd + 4, total).toString('utf8');
    recvBuf = recvBuf.slice(total);
    handleMsg(JSON.parse(body));
  }
});
