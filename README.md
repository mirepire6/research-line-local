# Research Line Local

Local AI is a Windows 10/11 x64 desktop assistant for a model you run in LM Studio. It supports chat, public web research with source links, and document conversion to Markdown. The desktop window, model requests and research run in Rust. Microsoft MarkItDown runs in an optional local Python environment.

## Start the app

1. Extract the Windows x64 release ZIP into a folder you can write to. The release contains the app, the optional converter setup, and documentation. Bring your own model and keep it in LM Studio’s model library.
2. Install [LM Studio](https://lmstudio.ai/download), open it, and load a compatible model you have obtained separately. Open **Developer** and start the local server on port `1234`. Keep **Serve on Local Network** and **Enable CORS** off. [LM Studio server guide](https://lmstudio.ai/docs/developer/core/server)
3. Open `research-line-local.exe` from the extracted folder. The default endpoint is `http://127.0.0.1:1234/v1`. If you set a model in the app, use the exact identifier shown by LM Studio. [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat)
4. Ask a question in **Agent** mode. Choose **Chat** for a local conversation, **Web search** to look up public sources, or **Deep research** to compare sources across searches.

If the desktop window cannot initialize, install Microsoft’s x64 Evergreen WebView2 Runtime. [WebView2 downloads](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

**System** follows the Windows appearance. Choose **Light** or **Dark** to override it. The interface uses the Windows accent color.

## Convert documents to Markdown

1. Install **CPython 3.13 x64**. Open PowerShell in the extracted folder. [Python for Windows](https://www.python.org/downloads/windows/)
2. Run the setup once. It downloads the pinned dependencies into `.venv` in that folder.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-markitdown.ps1
   ```

3. Restart Local AI and choose a document from the chat composer. The file is converted locally. Review or download the Markdown, or attach the text to your next message.

The converter accepts PDF, DOCX, XLSX, XLS, PPTX, HTML, CSV, TSV, TXT, Markdown, JSON, and XML. Each file can be up to **25 MiB**. The Markdown preview is limited to **100,000 characters**. For image-only scans, add a searchable text layer before converting. [Microsoft MarkItDown](https://github.com/microsoft/markitdown)

## Local and web features

Chat uses the model running on your computer. MarkItDown converts files locally and attachments go to the local model for document questions. Web-enabled requests send generated search queries and public URLs you ask to read to Exa for excerpts and links. Use **Chat** when working offline. [Exa web search](https://github.com/exa-labs/exa-mcp-server)

The optional **Folder helper** can use an existing compatible Local AI Work and Windows Sandbox installation. Launch with `--legacy-root <folder>` to point to it. The portable release works with chat, research and document conversion on its own.

## Hardware

The Windows reference configuration uses an **AMD Radeon RX 6650 XT** with LM Studio’s `llama.cpp` Vulkan runtime. NVIDIA GPUs are untested. See the [Windows AMD setup and troubleshooting guide](docs/amd-windows.md).

## Build from source

Use a current stable Rust toolchain on Windows x64. For the MSVC target, install Visual Studio Build Tools with the C++ desktop workload. For the GNU target, make the matching MinGW linker and `dlltool` available. [Rust installation](https://www.rust-lang.org/tools/install)

```powershell
cargo test --locked
cargo build --release --locked
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1
```

For a GNU build, pass `-WebViewLoader <path-to-x64-WebView2Loader.dll>` to the package script. Use the loader that ships with the pinned `webview2-com-sys` crate. The output ZIP is in `dist`. [Third-party components](docs/third-party.md)
