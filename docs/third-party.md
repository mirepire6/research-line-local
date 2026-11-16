# Third-party components

- The desktop embeds [Wry](https://github.com/tauri-apps/wry) and uses [Tao](https://github.com/tauri-apps/tao) for its window. Both are available under MIT and Apache 2.0.
- The Windows GNU bundle includes the x64 Microsoft WebView2 loader from [webview2-com-sys](https://crates.io/crates/webview2-com-sys). The system installs the evergreen WebView2 runtime separately. [Microsoft deployment guidance](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution#files-to-ship-with-the-app)
- The optional setup installs [Microsoft MarkItDown](https://github.com/microsoft/markitdown) into a local Python environment. The ZIP includes the adapter and dependency lock. The dependencies are fetched when the user runs setup.
- [Exa](https://github.com/exa-labs/exa-mcp-server) provides excerpts in web-enabled modes. LM Studio runs and manages user-provided model weights separately.

The Cargo lock file records the Rust dependency versions. The converter lock records the Python packages and hashes.
