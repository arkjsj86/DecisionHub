const els = {
  projectRoot: document.getElementById("projectRoot"),
  projectRootInput: document.getElementById("projectRootInput"),
  browseRootButton: document.getElementById("browseRootButton"),
  rgStatus: document.getElementById("rgStatus"),
  sessions: document.getElementById("sessions"),
  rounds: document.getElementById("rounds"),
  maxFiles: document.getElementById("maxFiles"),
  style: document.getElementById("style"),
  codexModel: document.getElementById("codexModel"),
  customCodexModel: document.getElementById("customCodexModel"),
  claudeModel: document.getElementById("claudeModel"),
  customClaudeModel: document.getElementById("customClaudeModel"),
  claudeEffort: document.getElementById("claudeEffort"),
  question: document.getElementById("question"),
  extraPaths: document.getElementById("extraPaths"),
  startButton: document.getElementById("startButton"),
  contextCount: document.getElementById("contextCount"),
  contextFiles: document.getElementById("contextFiles"),
  statusText: document.getElementById("statusText"),
  debateTabs: document.getElementById("debateTabs"),
  timeline: document.getElementById("timeline"),
};

let isRunning = false;
let tabs = [];
let activeTabIndex = -1;
const clientId = getClientId();
let heartbeatTimer = null;

boot();
startHeartbeat();

els.startButton.addEventListener("click", () => {
  if (!isRunning) startDebate();
});

els.browseRootButton.addEventListener("click", () => {
  browseForRoot();
});

els.sessions.addEventListener("click", onSessionAction);

els.question.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!isRunning) startDebate();
  }
});

async function boot() {
  await refreshHealth();
  await refreshSessions();
}

function getClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function startHeartbeat() {
  sendHeartbeat();
  heartbeatTimer = window.setInterval(sendHeartbeat, 4000);
  window.addEventListener("pagehide", notifyClientClose);
  window.addEventListener("beforeunload", notifyClientClose);
}

function sendHeartbeat() {
  fetch("/api/client-heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
    keepalive: true,
  }).catch(() => {});
}

function notifyClientClose() {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  const body = JSON.stringify({ clientId });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/client-close", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/client-close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

async function refreshHealth() {
  try {
    const data = await fetchJson("/api/health");
    els.projectRoot.textContent = data.projectRoot;
    els.projectRootInput.value = data.projectRoot;
    els.rgStatus.textContent = data.rgAvailable ? "rg ready" : "fallback walk";
    els.maxFiles.value = data.defaults?.maxContextFiles || 10;
  } catch (error) {
    els.projectRoot.textContent = "server error";
    addMessage({ agent: "Error", text: error.message, kind: "error" });
  }
}

async function refreshSessions() {
  try {
    const sessions = await fetchJson("/api/sessions");
    if (!sessions.length) {
      els.sessions.innerHTML = '<span class="muted">No local sessions yet.</span>';
      return;
    }
    els.sessions.innerHTML = sessions
      .slice(0, 8)
      .map((session) => {
        const id = escapeHtml(session.id);
        const title = escapeHtml(session.question || "(no question)");
        const date = new Date(session.createdAt).toLocaleString();
        const star = session.pinned ? "★" : "☆";
        return `
          <div class="session-item${session.pinned ? " pinned" : ""}" data-id="${id}">
            <div class="session-row">
              <a class="session-title" href="/api/sessions/log?id=${encodeURIComponent(session.id)}" target="_blank" rel="noopener" title="로그 열기">${title}</a>
              <div class="session-actions">
                <button type="button" class="icon-button pin-button" data-action="pin" aria-pressed="${session.pinned ? "true" : "false"}" title="${session.pinned ? "고정 해제" : "고정"}">${star}</button>
                <button type="button" class="icon-button delete-button" data-action="delete" title="삭제">🗑</button>
              </div>
            </div>
            <span class="muted">${date} · ${session.turns} turns</span>
          </div>`;
      })
      .join("");
  } catch {
    els.sessions.innerHTML = '<span class="muted">Could not load sessions.</span>';
  }
}

async function onSessionAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const item = button.closest(".session-item");
  const id = item && item.dataset.id;
  if (!id) return;
  const action = button.dataset.action;

  if (action === "pin") {
    const pinned = button.getAttribute("aria-pressed") !== "true";
    button.disabled = true;
    try {
      await fetchJson("/api/sessions/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, pinned }),
      });
      await refreshSessions();
    } catch {
      setStatus("고정 처리에 실패했어.");
      // The server may have applied the change before the response failed — resync.
      await refreshSessions();
    }
    return;
  }

  if (action === "delete") {
    if (!window.confirm("이 토론 로그를 삭제할까? (되돌릴 수 없어)")) return;
    button.disabled = true;
    try {
      await fetchJson("/api/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await refreshSessions();
    } catch {
      setStatus("삭제에 실패했어.");
      // The server may have deleted before the response failed — resync.
      await refreshSessions();
    }
  }
}

async function browseForRoot() {
  const previousText = els.browseRootButton.textContent;
  els.browseRootButton.disabled = true;
  els.browseRootButton.textContent = "Opening...";
  setStatus("Opening folder picker");

  try {
    const response = await fetchJson("/api/select-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialPath: els.projectRootInput.value.trim() }),
    });
    if (response.ok && response.path) {
      els.projectRootInput.value = response.path;
      els.projectRoot.textContent = response.path;
      setStatus("Root selected");
      return;
    }
    if (response.cancelled) {
      setStatus("Folder picker cancelled");
      return;
    }
    throw new Error(response.error || "Folder picker failed");
  } catch (error) {
    addMessage({ agent: "Error", text: error.message, kind: "error" });
    setStatus("Error");
  } finally {
    els.browseRootButton.disabled = false;
    els.browseRootButton.textContent = previousText;
  }
}

async function startDebate() {
  const question = els.question.value.trim();
  if (!question) {
    setStatus("질문을 먼저 입력해줘.");
    els.question.focus();
    return;
  }

  isRunning = true;
  els.startButton.disabled = true;
  els.startButton.textContent = "Running...";
  resetDebateView();
  els.contextFiles.innerHTML = '<div class="empty">관련 파일을 찾는 중...</div>';
  els.contextCount.textContent = "0 files";
  setStatus("Starting");

  const payload = {
    question,
    projectRoot: els.projectRootInput.value.trim(),
    rounds: Number(els.rounds.value || 2),
    maxFiles: Number(els.maxFiles.value || 10),
    style: els.style.value,
    codexModel: selectedCodexModel(),
    claudeModel: selectedClaudeModel(),
    claudeEffort: els.claudeEffort.value,
    extraPaths: els.extraPaths.value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };

  try {
    const response = await fetch("/api/debate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Request failed: ${response.status}`);
    }

    await readNdjsonStream(response.body, handleEvent);
  } catch (error) {
    addMessage({ agent: "Error", text: error.message, kind: "error" });
    setStatus("Error");
  } finally {
    isRunning = false;
    els.startButton.disabled = false;
    els.startButton.textContent = "Start Debate";
    await refreshSessions();
  }
}

function selectedCodexModel() {
  const custom = els.customCodexModel.value.trim();
  return custom || els.codexModel.value;
}

function selectedClaudeModel() {
  const custom = els.customClaudeModel.value.trim();
  return custom || els.claudeModel.value;
}

function handleEvent(event) {
  if (event.type === "status") {
    setStatus(event.message);
    return;
  }

  if (event.type === "context") {
    renderContext(event.files || []);
    return;
  }

  if (event.type === "turn") {
    addMessage(event);
    return;
  }

  if (event.type === "judge") {
    addMessage({ ...event, agent: "Judge", kind: "judge" });
    return;
  }

  if (event.type === "error") {
    addMessage({ agent: "Error", text: event.message, kind: "error" });
    setStatus("Error");
    return;
  }

  if (event.type === "done") {
    setStatus(`Done · ${event.sessionId}`);
  }
}

function renderContext(files) {
  els.contextCount.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
  if (!files.length) {
    els.contextFiles.innerHTML = '<div class="empty">관련 파일을 찾지 못했어.</div>';
    return;
  }
  els.contextFiles.innerHTML = files
    .map((file) => {
      return `
        <div class="file-card">
          <strong>${escapeHtml(file.path)}</strong>
          <div class="file-meta">
            <span class="pill">score ${Math.round(file.score || 0)}</span>
            <span class="pill">${escapeHtml(file.reason || "selected")}</span>
            <span class="pill">${Math.round((file.chars || 0) / 100) / 10}k chars</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function resetDebateView() {
  tabs = [];
  activeTabIndex = -1;
  els.debateTabs.innerHTML = "";
  els.debateTabs.classList.remove("has-tabs");
  els.timeline.removeAttribute("aria-labelledby");
  els.timeline.innerHTML = `
    <div class="welcome">
      <div class="welcome-title">Ready when you are.</div>
      <p>질문을 넣으면 프로젝트 파일을 읽고 Codex / Claude / Judge 순서로 토론을 보여준다.</p>
    </div>
  `;
}

function addMessage({ agent, round, text, kind }) {
  const type = kind || String(agent || "").toLowerCase();

  const card = document.createElement("article");
  card.className = `message-card ${type}`;
  card.innerHTML = `
    <div class="message-head">
      <div class="speaker"><span class="speaker-dot"></span>${escapeHtml(agent || "Agent")}</div>
      <div class="round">${round ? `Round ${round}` : ""}</div>
    </div>
    <div class="message-body">${renderRichText(text || "")}</div>
  `;

  // Were we parked on the latest tab? If so, follow the live edge forward.
  const wasAtLiveEdge = activeTabIndex === tabs.length - 1;
  const index = tabs.length;

  const tabButton = document.createElement("button");
  tabButton.type = "button";
  tabButton.id = `debate-tab-${index}`;
  tabButton.className = `debate-tab ${type}`;
  tabButton.setAttribute("role", "tab");
  tabButton.setAttribute("aria-controls", "timeline");
  tabButton.innerHTML = `
    <span class="tab-dot" aria-hidden="true"></span>
    <span class="tab-label">${escapeHtml(tabTitle(agent, round, type))}</span>
    <span class="tab-new" aria-hidden="true" hidden></span>
  `;
  tabButton.addEventListener("click", () => activateTab(index));
  els.debateTabs.appendChild(tabButton);
  els.debateTabs.classList.add("has-tabs");

  tabs.push({ card, tabButton });

  if (wasAtLiveEdge) {
    activateTab(index);
  } else {
    tabButton.classList.add("is-new");
    const dot = tabButton.querySelector(".tab-new");
    if (dot) dot.hidden = false;
  }
}

function tabTitle(agent, round, type) {
  const name = agent || "Agent";
  if (type === "judge") return "Judge";
  if (type === "error") return "Error";
  return round ? `${name} · R${round}` : name;
}

function activateTab(index) {
  if (index < 0 || index >= tabs.length) return;
  activeTabIndex = index;

  tabs.forEach((tab, i) => {
    const isActive = i === index;
    tab.tabButton.classList.toggle("active", isActive);
    tab.tabButton.setAttribute("aria-selected", isActive ? "true" : "false");
    if (isActive) {
      tab.tabButton.classList.remove("is-new");
      const dot = tab.tabButton.querySelector(".tab-new");
      if (dot) dot.hidden = true;
    }
  });

  els.timeline.innerHTML = "";
  els.timeline.appendChild(tabs[index].card);
  els.timeline.setAttribute("aria-labelledby", tabs[index].tabButton.id);
  els.timeline.scrollTop = 0;
  tabs[index].tabButton.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function setStatus(text) {
  els.statusText.textContent = text || "Idle";
}

async function readNdjsonStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line));
    }
  }

  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} failed with ${response.status}`);
  return response.json();
}

function renderRichText(text) {
  const parts = String(text).split("```");
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const cleaned = part.replace(/^\w+\n/, "");
        return `<pre><code>${escapeHtml(cleaned)}</code></pre>`;
      }
      return renderMarkdownLines(part);
    })
    .join("");
}

function renderMarkdownLines(text) {
  const lines = String(text).split(/\r?\n/);
  const html = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inlineFormat(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inlineFormat(numbered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineFormat(trimmed)}</p>`);
  }

  closeList();
  return html.join("");
}

function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
