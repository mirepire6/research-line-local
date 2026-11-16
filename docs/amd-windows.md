# AMD setup on Windows

Version 0.1.0 was verified on Windows x64 with an **AMD Radeon RX 6650 XT (8 GB)**, LM Studio 0.4.28+2, and the selected `llama.cpp-win-x86_64-vulkan-avx2@2.67.0` runtime. The test used a 4B GGUF model in Q5_K_M, an 8,192-token context, and maximum GPU offload. Local chat, a MarkItDown attachment, and an automatic web lookup passed. LM Studio runs inference and controls GPU offload. NVIDIA GPUs are untested. [RX 6650 XT specifications and drivers](https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-6000-series/amd-radeon-rx-6650-xt.html)

## Configure LM Studio

1. Install the Windows x64 [LM Studio release](https://lmstudio.ai/download). Use an AMD Adrenalin driver for your GPU and Windows version. [AMD driver lookup](https://www.amd.com/en/support/downloads/drivers.html)
2. In LM Studio, press **Ctrl+Shift+R** and select the Windows `llama.cpp` **Vulkan** runtime. Install it from the runtime manager if needed. With the bundled `lms` CLI you can also use `lms runtime ls` to inspect installed runtimes and `lms runtime select` to choose one. [LM Studio runtimes](https://lmstudio.ai/docs/app)
3. Load a compatible GGUF from your LM Studio library. For an 8 GB card, start with a compact quantized model and a 4,096-token context. Increase GPU offload as memory permits. If you want to estimate memory before loading, run `lms load --estimate-only` and select the model. [LM Studio model loading](https://lmstudio.ai/docs/cli/local-models/load)
4. Open **Developer**, start the server on `127.0.0.1` port `1234`, and leave **Serve on Local Network** and **Enable CORS** off. The CLI equivalent is below. [Server options](https://lmstudio.ai/docs/cli/serve/server-start)

   ```powershell
   lms server start --bind 127.0.0.1 --port 1234
   ```

5. Open Local AI and use `http://127.0.0.1:1234/v1` as the endpoint. Send a short prompt in **Chat** mode. To confirm Vulkan acceleration, check the active runtime in LM Studio and watch dedicated GPU memory while it generates.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App cannot reach LM Studio | Confirm that **Developer** shows the server running. In PowerShell, run `Invoke-RestMethod http://127.0.0.1:1234/v1/models`. If it fails, confirm the port and check LM Studio’s server log. |
| The app connects but generation fails | Load a chat-capable model in LM Studio. Compare the model identifier in the app with the `id` returned by `/v1/models`. [List models](https://lmstudio.ai/docs/developer/openai-compat/models) |
| Vulkan is missing or loading fails | Check your installed AMD driver and the runtime selection. Reload a smaller quantized model, lower the context length, or move fewer layers to the GPU. [GPU offload and context settings](https://lmstudio.ai/docs/cli/local-models/load) |
| The GPU has little headroom | Unload idle models and close GPU-heavy apps. Lower the context length first if generation uses substantial shared memory or becomes unstable. |

When reporting an issue, include the GPU, VRAM, driver version, LM Studio version, active runtime, model and quantization, context length, and GPU offload setting. Share the error text separately from any private prompt or document.
