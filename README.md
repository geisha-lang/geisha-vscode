# Geisha Language Support for VS Code

Official Visual Studio Code extension for the [Geisha](https://github.com/geisha-lang/geisha.gsa) programming language (`.gsa`), powered by the built-in `geisha lsp` Language Server.

## Features

- **Syntax Highlighting**: TextMate grammar (`syntaxes/geisha.tmLanguage.json`) covering Geisha keywords, ADT/concept/instance declarations, `///` doc comments, radix/separator numeric literals (`0x`, `0o`, `0b`, `_`), strings/escapes, and built-in types/primitives.
- **Language Configuration**: Auto-closing brackets/quotes, comment toggling (`//` and `/* ... */`), and indentation rules (`language-configuration.json`).
- **Live Diagnostics**: Real-time lex/parse/type/exhaustiveness/`Send` diagnostics from `geisha lsp`.
- **Hover**: Inferred expression/symbol types combined with `///` doc comments.
- **Go to Definition**: Jump to local bindings, top-level definitions, ADT constructors, and cross-file definitions.
- **Find All References**: Scope-aware cross-file references for local variables, functions, types, enum variants, and struct fields.
- **Rename Symbol**: Scope-aware single-file and cross-file rename with `prepareRename` validation.
- **Inlay Hints**: Inferred `let` variable type hints and function call parameter name hints.
- **Code Actions (Quick Fixes)**: Prefix unused local variables with `_`, insert missing `match` arm skeletons, and auto-import undefined symbols.
- **Document Symbols**: Hierarchical outline of `def`, `extern def`, `data` (+ variants), `type`, `concept` (+ methods), `instance`, and `mod`.
- **Completion**: Current-module symbols, imported symbols, `std.*` / `sys.*` modules & exports, built-in primitives, and keywords.

## Prerequisites

Ensure the `geisha` compiler binary is installed and available on your `PATH` (or configure `geisha.lsp.path` in VS Code settings):

```sh
# From the geisha.gsa repository root:
make runtime wasm-runtime bootstrap && make install
```

## Local Installation (Zero Dependencies)

This extension uses a lightweight, zero-dependency stdio JSON-RPC 2.0 client, so no `npm install` is required for local use.

### Option 1: Symlink into VS Code Extensions Directory

```sh
git clone https://github.com/geisha-lang/geisha-vscode.git
ln -s "$(pwd)/geisha-vscode" "$HOME/.vscode/extensions/geisha-lang"
```

Reload VS Code (`Developer: Reload Window`) and open any `.gsa` file.

### Option 2: Package as `.vsix` and Install

```sh
cd geisha-vscode
npm run check
npm run package   # runs: npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension geisha-lang-0.1.0.vsix
```

### Option 3: Extension Development Host

Open this repository in VS Code and press `F5` to launch an Extension Development Host window.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `geisha.lsp.path` | `"geisha"` | Path to the `geisha` CLI executable. |
| `geisha.lsp.args` | `["lsp"]` | Arguments passed to start the LSP server. |
| `geisha.lsp.trace` | `"off"` | Trace JSON-RPC traffic (`"off"`, `"messages"`, or `"verbose"`) in the *Geisha Language Server* output channel. |

## Commands

- **Geisha: Restart Language Server** (`geisha.lsp.restart`) — Restart the underlying `geisha lsp` process.
