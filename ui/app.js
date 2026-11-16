"use strict";

const byId = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="local-ai-token"]').content;
const desktop = typeof window.ipc?.postMessage === "function";
const root = document.documentElement;
const shell = byId("shell");
const prompt = byId("prompt");
const messages = byId("messages");
const scrollArea = byId("scroll-area");
const mode = byId("mode");
const modeNotes = {
  agent: "Agent can search the public web when needed.",
  chat: "Conversation with your local model.",
  web: "Searches the public web and cites sources.",
  deep: "Runs follow-up searches and compares sources.",
  folder: "Use files and tools in your Local AI Work folder.",
};

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem("local-ai." + key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem("local-ai." + key, JSON.stringify(value));
  } catch {
    // The active conversation remains available if local storage is full or disabled.
  }
}

function validChats(data) {
  if (!Array.isArray(data)) return [];
  return data.filter((chat) => chat && typeof chat.id === "string" && typeof chat.title === "string"
    && Array.isArray(chat.turns) && chat.turns.every((turn) => turn
      && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string")).slice(0, 30);
}

function blankChat() {
  return { id: crypto.randomUUID(), title: "New conversation", turns: [] };
}

const savedChats = validChats(readStorage("chats", []));
const state = {
  chats: savedChats,
  current: savedChats.find((chat) => chat.id === readStorage("current", "")) ?? blankChat(),
  documents: new Map(),
  request: null,
  imports: 0,
  preview: null,
  legacy: false,
  converter: null,
  endpoint: "",
};

function saveChats() {
  const snapshot = state.chats.slice(0, 30).map((chat) => ({
    ...chat,
    turns: chat.turns.filter((turn) => turn.content).slice(-64).map((turn) => ({
      ...turn, content: turn.content.slice(0, 48_000), pending: false,
    })),
  }));
  writeStorage("chats", snapshot);
  writeStorage("current", state.current.id);
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function makeButton(className, label, symbol) {
  const button = element("button", className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(symbol));
  return button;
}

function setTheme(value) {
  if (!["system", "light", "dark"].includes(value)) value = "system";
  root.dataset.theme = value;
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === value));
  }
  writeStorage("theme", value);
}

function setSidebar(open) {
  shell.classList.toggle("sidebar-closed", !open);
  byId("sidebar").inert = !open;
  byId("toggle-sidebar").setAttribute("aria-expanded", String(open));
}

function setActivity(message = "", error = false) {
  const activity = byId("activity");
  activity.textContent = message;
  activity.dataset.error = String(error);
}

function setModeNotes() {
  byId("mode-note").textContent = modeNotes[mode.value] ?? modeNotes.agent;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + token);
  const response = await fetch(path, { ...options, headers, cache: "no-store", mode: "same-origin" });
  if (response.ok) return response;
  let details;
  try { details = await response.json(); } catch { /* Some connection errors have no JSON body. */ }
  throw new Error(details?.message || details?.error || "Local AI returned HTTP " + response.status + ".");
}

function asJson(value) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

async function updateStatus() {
  if (document.hidden) return;
  try {
    const status = await (await api("/api/status", { signal: AbortSignal.timeout(6000) })).json();
    state.endpoint = status.endpoint || state.endpoint;
    state.legacy = status.legacy === true;
    state.converter = status.converter;
    byId("folder-mode").disabled = !state.legacy;
    if (!state.legacy && mode.value === "folder") mode.value = "agent";
    byId("backend-status").dataset.connected = String(Boolean(status.connected));
    byId("model-status").textContent = status.connected ? (status.model || "Local model connected") : "Model offline";
    if (typeof status.accent === "string" && /^#[a-f\d]{6}$/i.test(status.accent)) {
      root.style.setProperty("--accent-system", status.accent);
    }
    setModeNotes();
  } catch {
    byId("backend-status").dataset.connected = "false";
    byId("model-status").textContent = "Model unavailable";
  }
}

function publicLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(target) {
  const link = element("a");
  link.href = target;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  if (desktop) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.ipc.postMessage(JSON.stringify({ open: target }));
    });
  }
  return link;
}

const inlineTokens = /(\x60[^\x60\n]+\x60|\[[^\]\n]+\]\([^)\s]+\)|<https:\/\/[^ >]+>|https:\/\/[^\s<>]+|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;

function inlineMarkdown(value, node, depth = 0) {
  if (depth > 3) {
    node.append(value);
    return;
  }
  let cursor = 0;
  for (const match of value.matchAll(inlineTokens)) {
    node.append(value.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const literal = match[0];
    if (literal.charCodeAt(0) === 96) {
      node.append(element("code", "", literal.slice(1, -1)));
      continue;
    }
    const markdownLink = /^\[([^\]]+)\]\((.+)\)$/.exec(literal);
    const linkText = markdownLink ? markdownLink[1] : literal.replace(/^<|>$/g, "");
    const rawTarget = markdownLink ? markdownLink[2] : linkText;
    const trimmedTarget = markdownLink ? rawTarget : rawTarget.replace(/[.,;:!?]+$/, "");
    const target = publicLink(trimmedTarget);
    if (target) {
      const link = externalLink(target);
      link.textContent = markdownLink ? linkText : trimmedTarget;
      node.append(link, rawTarget.slice(trimmedTarget.length));
      continue;
    }
    const decoration = literal.slice(0, 2);
    const pair = { "**": "strong", "__": "strong", "~~": "del" }[decoration];
    if (pair || literal.startsWith("*") || literal.startsWith("_")) {
      const span = element(pair || "em");
      const width = pair ? 2 : 1;
      inlineMarkdown(literal.slice(width, -width), span, depth + 1);
      node.append(span);
    } else {
      node.append(literal);
    }
  }
  node.append(value.slice(cursor));
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((part) => part.trim().replace(/\\\|/g, "|"));
}

function markdown(value) {
  const fragment = document.createDocumentFragment();
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const listItem = /^\s*([-+*]|\d+\.)\s+(.+)$/;
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const block = element("p");
    inlineMarkdown(paragraph.join(" "), block);
    fragment.append(block);
    paragraph = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const openingFence = /^\s*(\x60{3,}|~{3,})/.exec(line);
    if (openingFence) {
      flushParagraph();
      const fenced = [];
      const marker = openingFence[1];
      for (index += 1; index < lines.length; index += 1) {
        if (lines[index].trim().startsWith(marker)) break;
        fenced.push(lines[index]);
      }
      const pre = element("pre");
      pre.append(element("code", "", fenced.join("\n")));
      fragment.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const block = element("h" + Math.min(heading[1].length + 1, 6));
      inlineMarkdown(heading[2], block);
      fragment.append(block);
      continue;
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      fragment.append(element("hr"));
      continue;
    }
    const list = listItem.exec(line);
    if (list) {
      flushParagraph();
      const ordered = list[1].endsWith(".");
      const block = element(ordered ? "ol" : "ul");
      if (ordered) block.start = Number.parseInt(list[1], 10);
      for (; index < lines.length; index += 1) {
        const item = listItem.exec(lines[index]);
        if (!item || item[1].endsWith(".") !== ordered) break;
        const child = element("li");
        inlineMarkdown(item[2], child);
        block.append(child);
      }
      index -= 1;
      fragment.append(block);
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flushParagraph();
      const block = element("blockquote");
      const quote = [];
      for (; index < lines.length && lines[index].trimStart().startsWith(">"); index += 1) {
        quote.push(lines[index].trimStart().slice(1).trimStart());
      }
      index -= 1;
      inlineMarkdown(quote.join(" "), block);
      fragment.append(block);
      continue;
    }
    const columnDivider = lines[index + 1];
    if (line.includes("|") && columnDivider?.includes("|") && cells(columnDivider).every((part) => /^:?-{3,}:?$/.test(part))) {
      flushParagraph();
      const wrapper = element("div", "table-scroll");
      const table = element("table");
      const titles = cells(line);
      const header = table.createTHead().insertRow();
      for (const title of titles) {
        const th = element("th");
        th.scope = "col";
        inlineMarkdown(title, th);
        header.append(th);
      }
      const body = table.createTBody();
      for (index += 2; index < lines.length && lines[index].includes("|"); index += 1) {
        const row = body.insertRow();
        const values = cells(lines[index]);
        for (let column = 0; column < titles.length; column += 1) {
          inlineMarkdown(values[column] || "", row.insertCell());
        }
      }
      index -= 1;
      wrapper.append(table);
      fragment.append(wrapper);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return fragment;
}

function titleFor(text) {
  const title = text.trim().replace(/\s+/g, " ");
  return title.length > 43 ? title.slice(0, 41).trimEnd() + "…" : title;
}

function currentDocuments() {
  return state.documents.get(state.current.id) ?? [];
}

function renderHistory() {
  const list = byId("chat-list");
  list.replaceChildren();
  byId("history").hidden = !state.chats.length;
  for (const chat of state.chats) {
    const row = element("div", "history-row");
    row.dataset.current = String(chat === state.current);
    const select = makeButton("history-select", chat.title, "chat");
    select.append(element("span", "", chat.title));
    if (chat === state.current) select.setAttribute("aria-current", "page");
    select.addEventListener("click", () => setChat(chat));
    const remove = makeButton("history-remove", "Delete " + chat.title, "trash");
    remove.addEventListener("click", () => {
      if (state.request) return;
      state.chats = state.chats.filter((item) => item !== chat);
      state.documents.delete(chat.id);
      if (state.current === chat) setChat(state.chats[0] ?? blankChat());
      saveChats();
      renderHistory();
    });
    row.append(select, remove);
    list.append(row);
  }
}

function renderSourceLinks(values, content) {
  if (!Array.isArray(values) || !values.length) return;
  const row = element("div", "message-sources");
  const seen = new Set();
  for (const item of values) {
    const target = publicLink(item?.url);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const label = item.title || new URL(target).hostname;
    const link = externalLink(target);
    link.title = label;
    link.append(icon("arrow-out"), element("span", "", label));
    row.append(link);
  }
  if (row.childNodes.length) content.append(row);
}

function renderMessage(turn) {
  const article = element("article", "message " + turn.role);
  article.setAttribute("aria-label", turn.role === "user" ? "You" : "Local AI");
  if (turn.role === "assistant") {
    const avatar = element("div", "assistant-icon");
    avatar.append(icon("logo"));
    article.append(avatar);
  }
  const content = element("div", "message-content");
  article.append(content);
  updateMessage(turn, content);
  return { article, content };
}

function updateMessage(turn, content) {
  content.replaceChildren();
  if (turn.role === "user") {
    content.append(turn.content);
    if (turn.files?.length) {
      const files = element("div", "message-files");
      for (const name of turn.files) files.append(element("span", "", name));
      content.append(files);
    }
    return;
  }
  if (turn.content) {
    content.append(markdown(turn.content));
  } else if (turn.pending) {
    content.append(element("p", "message-pending", "Thinking…"));
  }
  renderSourceLinks(turn.sources, content);
  if (turn.error) content.append(element("p", "message-error", turn.error));
}

function renderConversation() {
  const turns = state.current.turns;
  byId("chat-title").textContent = state.current.title;
  byId("welcome").hidden = Boolean(turns.length);
  messages.replaceChildren(...turns.map((turn) => renderMessage(turn).article));
  scrollToBottom(true);
}

function renderAttachments() {
  const row = byId("attachments");
  const items = currentDocuments();
  row.hidden = !items.length;
  row.replaceChildren();
  for (const item of items) {
    const part = element("div", "attachment");
    const preview = makeButton("attachment-preview", "Preview Markdown for " + item.name, "doc");
    preview.append(element("span", "", item.name));
    preview.addEventListener("click", () => showPreview(item));
    const remove = makeButton("attachment-remove", "Remove " + item.name, "close");
    remove.addEventListener("click", () => {
      if (state.request) return;
      state.documents.set(state.current.id, currentDocuments().filter((document) => document !== item));
      renderAttachments();
      syncComposer();
    });
    part.append(preview, remove);
    row.append(part);
  }
}

function setChat(chat) {
  if (state.request) {
    setActivity("Stop the current response before switching chats.");
    return;
  }
  if (state.current !== chat) prompt.value = "";
  state.current = chat;
  saveChats();
  renderHistory();
  renderConversation();
  renderAttachments();
  resetPromptSize();
  syncComposer();
  setActivity();
  if (window.matchMedia("(max-width: 560px)").matches) setSidebar(false);
  prompt.focus();
}

function scrollToBottom(force = false) {
  const nearBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 120;
  if (force || nearBottom) scrollArea.scrollTop = scrollArea.scrollHeight;
}

function resetPromptSize() {
  prompt.style.height = "auto";
  prompt.style.height = Math.min(prompt.scrollHeight, 156) + "px";
}

function syncComposer() {
  const active = Boolean(state.request);
  const ready = Boolean(prompt.value.trim() || currentDocuments().length);
  byId("send").disabled = active || !ready || Boolean(state.imports);
  byId("send").hidden = active;
  byId("stop").hidden = !active;
  byId("stop").disabled = Boolean(state.request?.stopping);
  byId("attach").disabled = active || Boolean(state.imports);
  mode.disabled = active;
}

function processEvent(event, turn) {
  if (event.type === "status") setActivity(event.message || "");
  if (event.type === "delta" && typeof event.text === "string") turn.content += event.text;
  if (event.type === "sources" && Array.isArray(event.sources)) turn.sources = [...(turn.sources ?? []), ...event.sources];
  if (event.type === "error") throw new Error(event.message || "The response could not be completed.");
  return event.type === "done";
}

async function submit() {
  if (state.request || state.imports) return;
  const documents = currentDocuments();
  const question = prompt.value.trim() || (documents.length ? "Summarize the attached documents." : "");
  if (!question) return;

  const chat = state.current;
  if (!chat.turns.length) {
    chat.title = titleFor(question);
    state.chats.unshift(chat);
  }
  const user = { role: "user", content: question, files: documents.map((item) => item.name) };
  const assistant = { role: "assistant", content: "", sources: [], pending: true };
  chat.turns.push(user);
  const input = chat.turns.filter((turn) => turn.content).slice(-20).map(({ role, content }) => ({ role, content }));
  chat.turns.push(assistant);
  const controller = new AbortController();
  const request = { controller, stopping: false };
  state.request = request;
  saveChats();
  prompt.value = "";
  resetPromptSize();
  syncComposer();
  renderHistory();
  byId("chat-title").textContent = chat.title;
  byId("welcome").hidden = true;
  const reply = renderMessage(assistant);
  messages.append(renderMessage(user).article, reply.article);
  scrollToBottom(true);
  setActivity("Thinking…");
  let imageFrame = 0;

  function repaint() {
    if (imageFrame) return;
    imageFrame = requestAnimationFrame(() => {
      imageFrame = 0;
      const pinned = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 120;
      updateMessage(assistant, reply.content);
      if (pinned) scrollToBottom(true);
    });
  }

  try {
    const response = await api("/api/chat", {
      method: "POST",
      ...asJson({
        messages: input,
        mode: mode.value,
        attachments: documents.map(({ name, markdown }) => ({ name, markdown })),
      }),
      signal: controller.signal,
    });
    if (!response.body) throw new Error("The local service returned an empty response.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let completed = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) completed = processEvent(JSON.parse(line), assistant) || completed;
          newline = buffer.indexOf("\n");
        }
        repaint();
      }
      if (buffer.trim()) completed = processEvent(JSON.parse(buffer), assistant) || completed;
    } finally {
      reader.releaseLock();
    }
    if (!completed && !request.stopping) throw new Error("The local model closed the response early.");
    if (!assistant.content && !request.stopping) throw new Error("The local model returned an empty response.");
    setActivity(request.stopping ? "Response stopped." : "");
  } catch (error) {
    if (request.stopping || error.name === "AbortError") {
      if (!assistant.content) assistant.error = "Response stopped.";
      setActivity();
    } else {
      assistant.error = error.message || "The local model could not respond.";
      setActivity();
    }
  } finally {
    if (imageFrame) cancelAnimationFrame(imageFrame);
    assistant.pending = false;
    if (!assistant.content && !assistant.error) assistant.error = "Response stopped.";
    updateMessage(assistant, reply.content);
    saveChats();
    state.request = null;
    syncComposer();
    scrollToBottom();
    prompt.focus({ preventScroll: true });
  }
}

async function stopResponse() {
  const request = state.request;
  if (!request || request.stopping) return;
  request.stopping = true;
  syncComposer();
  setActivity("Stopping…");
  try {
    await api("/api/cancel", { method: "POST", signal: AbortSignal.timeout(2500) });
  } catch {
    // Closing the response stream also releases the client connection.
  } finally {
    request.controller.abort();
  }
}

async function importDocuments(files) {
  if (state.request || state.imports || !files.length) return;
  const target = state.current;
  const existing = currentDocuments();
  const errors = [];
  state.imports += 1;
  syncComposer();
  for (const file of files) {
    if (existing.length >= 4 && !existing.some((item) => item.name === file.name)) {
      errors.push("Attach up to four documents per chat.");
      break;
    }
    if (state.current === target) setActivity("Converting " + file.name + "…");
    try {
      const response = await api("/api/documents/convert", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
        body: file,
      });
      const document = await response.json();
      if (typeof document.markdown !== "string") throw new Error("MarkItDown returned an unreadable result.");
      const converted = { name: document.name || file.name, markdown: document.markdown, truncated: Boolean(document.truncated) };
      const previous = existing.findIndex((item) => item.name === converted.name);
      if (previous < 0) existing.push(converted); else existing[previous] = converted;
      state.documents.set(target.id, existing);
    } catch (error) {
      errors.push(file.name + " — " + (error.message || "Could not convert this document."));
    }
  }
  state.imports -= 1;
  syncComposer();
  if (state.current !== target) return;
  renderAttachments();
  setActivity(errors.join(" "), Boolean(errors.length));
  prompt.focus();
}

function showPreview(document) {
  state.preview = document;
  byId("preview-title").textContent = document.name + (document.truncated ? " (preview truncated)" : "");
  byId("preview-text").textContent = document.markdown || "This document contains no extractable text.";
  byId("preview-dialog").showModal();
}

async function copyMarkdown() {
  if (!state.preview) return;
  const button = byId("copy-markdown");
  const label = button.lastChild;
  try {
    await navigator.clipboard.writeText(state.preview.markdown);
    label.textContent = "Copied";
  } catch {
    label.textContent = "Could not copy";
  }
  window.setTimeout(() => { label.textContent = "Copy Markdown"; }, 1400);
}

function downloadMarkdown() {
  if (!state.preview) return;
  const file = new Blob([state.preview.markdown], { type: "text/markdown;charset=utf-8" });
  const target = URL.createObjectURL(file);
  const link = element("a");
  link.href = target;
  link.download = state.preview.name.replace(/\.[^.]+$/, "") + ".md";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(target), 3000);
}

function settingsError(message = "") {
  const error = byId("settings-error");
  error.textContent = message;
  error.hidden = !message;
}

async function openSettings() {
  const dialog = byId("settings-dialog");
  if (dialog.open) return;
  settingsError();
  byId("endpoint").value = state.endpoint;
  byId("model").value = "";
  byId("save-settings").disabled = true;
  dialog.showModal();
  try {
    const fields = await (await api("/api/settings", { signal: AbortSignal.timeout(6000) })).json();
    byId("endpoint").value = fields.endpoint || state.endpoint;
    byId("model").value = fields.model || "";
  } catch (error) {
    settingsError(error.message || "Could not read local settings.");
  } finally {
    byId("save-settings").disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  settingsError();
  const save = byId("save-settings");
  save.disabled = true;
  try {
    const fields = { endpoint: byId("endpoint").value.trim(), model: byId("model").value.trim() };
    await api("/api/settings", { method: "PUT", ...asJson(fields), signal: AbortSignal.timeout(6000) });
    state.endpoint = fields.endpoint;
    byId("settings-dialog").close();
    void updateStatus();
  } catch (error) {
    settingsError(error.message || "Could not save local settings.");
  } finally {
    save.disabled = false;
  }
}

function attachFile() {
  if (state.request || state.imports) return;
  if (state.converter === false) {
    setActivity("MarkItDown is not set up. Follow the installation steps in the README.", true);
    return;
  }
  byId("file-input").click();
}

byId("new-chat").addEventListener("click", () => setChat(blankChat()));
byId("toggle-sidebar").addEventListener("click", () => setSidebar(shell.classList.contains("sidebar-closed")));
byId("settings").addEventListener("click", openSettings);
byId("backend-status").addEventListener("click", openSettings);
byId("settings-form").addEventListener("submit", saveSettings);
byId("composer").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
byId("stop").addEventListener("click", stopResponse);
byId("attach").addEventListener("click", attachFile);
byId("download-markdown").addEventListener("click", downloadMarkdown);
byId("copy-markdown").addEventListener("click", copyMarkdown);
byId("file-input").addEventListener("change", (event) => {
  void importDocuments(Array.from(event.target.files));
  event.target.value = "";
});
mode.addEventListener("change", setModeNotes);
prompt.addEventListener("input", () => { resetPromptSize(); syncComposer(); });
prompt.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
  event.preventDefault();
  void submit();
});

for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
}
for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => byId(button.dataset.closeDialog).close());
}
for (const button of document.querySelectorAll("[data-starter]")) {
  button.addEventListener("click", () => {
    if (button.dataset.starter === "document") {
      attachFile();
      return;
    }
    prompt.value = button.dataset.starter;
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    resetPromptSize();
    syncComposer();
  });
}

const composer = byId("composer");
composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  if (!state.request && !state.imports) composer.classList.add("is-dragging");
});
composer.addEventListener("dragleave", (event) => {
  if (!composer.contains(event.relatedTarget)) composer.classList.remove("is-dragging");
});
composer.addEventListener("drop", (event) => {
  event.preventDefault();
  composer.classList.remove("is-dragging");
  void importDocuments(Array.from(event.dataTransfer.files));
});
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "n" && (event.ctrlKey || event.metaKey) && !event.altKey) {
    event.preventDefault();
    if (!document.querySelector("dialog[open]")) setChat(blankChat());
  }
});

if (desktop) {
  root.classList.add("native-window");
  for (const button of document.querySelectorAll("[data-window]")) {
    button.addEventListener("click", () => window.ipc.postMessage(button.dataset.window));
  }
  for (const zone of document.querySelectorAll("[data-drag]")) {
    zone.addEventListener("mousedown", (event) => {
      if (event.button === 0 && !event.target.closest("button, a, input, select")) window.ipc.postMessage("drag");
    });
    zone.addEventListener("dblclick", (event) => {
      if (!event.target.closest("button, a, input, select")) window.ipc.postMessage("maximize");
    });
  }
}

setTheme(readStorage("theme", "system"));
setSidebar(!window.matchMedia("(max-width: 560px)").matches);
renderHistory();
renderConversation();
syncComposer();
void updateStatus();
document.addEventListener("visibilitychange", updateStatus);
window.setInterval(updateStatus, 8000);
