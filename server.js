import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOL_NAME = "project-decision-hub";

loadDotEnv(path.join(__dirname, ".env"));

const env = process.env;
const PORT = Number(env.PORT || 8787);
const MAX_CONTEXT_FILES = Number(env.MAX_CONTEXT_FILES || 10);
const MAX_CONTEXT_CHARS = Number(env.MAX_CONTEXT_CHARS || 55000);
const MAX_FILE_CHARS = Number(env.MAX_FILE_CHARS || 10000);
const MAX_OUTPUT_TOKENS = Number(env.MAX_OUTPUT_TOKENS || 2200);
const CODEX_PROVIDER = (env.CODEX_PROVIDER || env.OPENAI_PROVIDER || "cli").toLowerCase();
const CLAUDE_PROVIDER = (env.CLAUDE_PROVIDER || env.ANTHROPIC_PROVIDER || "cli").toLowerCase();
const OPENAI_MODEL = env.OPENAI_MODEL || "gpt-5.5";
const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || "claude-opus-4-7";
const CODEX_MODEL = env.CODEX_MODEL || env.OPENAI_MODEL || "gpt-5.4";
const CLAUDE_MODEL = env.CLAUDE_MODEL || "";
const CODEX_CLI_PATH = env.CODEX_CLI_PATH || defaultCodexCliPath();
const CLAUDE_CLI_PATH = env.CLAUDE_CLI_PATH || "claude";
const CLI_TIMEOUT_MS = Number(env.CLI_TIMEOUT_MS || 600000);
const AUTO_SHUTDOWN_ON_IDLE = parseBool(env.AUTO_SHUTDOWN_ON_IDLE, true);
const CLIENT_HEARTBEAT_TTL_MS = Number(env.CLIENT_HEARTBEAT_TTL_MS || 15000);
const AUTO_SHUTDOWN_GRACE_MS = Number(env.AUTO_SHUTDOWN_GRACE_MS || 5000);

const STATIC_ROOT = path.join(__dirname, "public");
const SESSIONS_ROOT = path.join(__dirname, "sessions");
const LOGS_ROOT = path.join(__dirname, "logs");
const DEFAULT_PROJECT_ROOT = resolveProjectRoot();
const activeClients = new Map();
let hasSeenClient = false;
let shutdownTimer = null;
let activeDebates = 0;

fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
fs.mkdirSync(LOGS_ROOT, { recursive: true });
backfillLogs();

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

const CODE_EXTENSIONS = new Set([
  ".gd",
  ".md",
  ".json",
  ".cfg",
  ".txt",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".cs",
  ".cpp",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".rb",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".csv",
]);

const IGNORE_PARTS = new Set([
  ".git",
  ".godot",
  ".godot_appdata",
  ".test",
  "node_modules",
  "build",
  "steam_build",
  "steamworks_sdk_164",
  "sessions",
  TOOL_NAME,
]);

const TOPIC_HINTS = [
  {
    terms: ["maze", "메이즈", "미로", "map", "맵", "stage", "스테이지", "보스"],
    paths: ["maze", "map", "stage", "boss", "wave", "balance"],
  },
  {
    terms: ["price", "가격", "steam", "스팀", "market", "시장", "release", "출시"],
    paths: ["market", "steam", "release", "remaining", "roadmap", "store"],
  },
  {
    terms: ["build", "빌드", "tower", "타워", "balance", "밸런스", "weapon", "무기"],
    paths: ["build", "tower", "balance", "weapon", "upgrade"],
  },
  {
    terms: ["story", "스토리", "ending", "엔딩", "credit", "크레딧"],
    paths: ["story", "ending", "credit", "dialogue"],
  },
  {
    terms: ["ui", "ux", "화면", "메뉴", "hud", "sidebar", "사이드바"],
    paths: ["ui", "hud", "menu", "sidebar", "theme"],
  },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        projectRoot: DEFAULT_PROJECT_ROOT,
        codexProvider: CODEX_PROVIDER,
        claudeProvider: CLAUDE_PROVIDER,
        hasOpenAIKey: Boolean(env.OPENAI_API_KEY),
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        openaiModel: OPENAI_MODEL,
        anthropicModel: ANTHROPIC_MODEL,
        codexModel: CODEX_MODEL,
        claudeModel: CLAUDE_MODEL || "default",
        codexCliPath: CODEX_CLI_PATH,
        claudeCliPath: CLAUDE_CLI_PATH,
        codexCliAvailable: CODEX_PROVIDER === "cli" ? isCommandAvailable(CODEX_CLI_PATH) : null,
        claudeCliAvailable: CLAUDE_PROVIDER === "cli" ? isCommandAvailable(CLAUDE_CLI_PATH) : null,
        rgAvailable: isRgAvailable(),
        defaults: {
          maxContextFiles: MAX_CONTEXT_FILES,
          maxContextChars: MAX_CONTEXT_CHARS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          autoShutdownOnIdle: AUTO_SHUTDOWN_ON_IDLE,
          autoShutdownGraceMs: AUTO_SHUTDOWN_GRACE_MS,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/client-heartbeat") {
      const body = await readJsonBody(req);
      const clientId = String(body.clientId || "").trim();
      if (clientId) {
        hasSeenClient = true;
        activeClients.set(clientId, Date.now());
        cancelShutdownTimer();
      }
      return sendJson(res, { ok: true, clients: countActiveClients() });
    }

    if (req.method === "POST" && url.pathname === "/api/client-close") {
      const body = await readJsonBody(req);
      const clientId = String(body.clientId || "").trim();
      if (clientId) activeClients.delete(clientId);
      scheduleShutdownIfIdle();
      return sendJson(res, { ok: true, clients: countActiveClients() });
    }

    if (req.method === "POST" && url.pathname === "/api/select-root") {
      return selectRootFolder(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, listSessions());
    }

    if (req.method === "GET" && url.pathname === "/api/sessions/log") {
      return serveSessionLog(url.searchParams.get("id"), res);
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/pin") {
      const body = await readJsonBody(req);
      return sendJson(res, setSessionPinned(body.id, body.pinned));
    }

    if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
      const body = await readJsonBody(req);
      return sendJson(res, deleteSession(body.id));
    }

    if (req.method === "POST" && url.pathname === "/api/debate") {
      return streamDebate(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message || String(error) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Project Decision Hub`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  Project: ${DEFAULT_PROJECT_ROOT}`);
  console.log(`  Codex provider: ${CODEX_PROVIDER} (${CODEX_PROVIDER === "cli" ? CODEX_MODEL : OPENAI_MODEL})`);
  console.log(`  Claude provider: ${CLAUDE_PROVIDER} (${CLAUDE_PROVIDER === "cli" ? CLAUDE_MODEL || "default" : ANTHROPIC_MODEL})`);
});

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function resolveProjectRoot() {
  const cliProjectArg = getArgValue("--project");
  const raw = cliProjectArg || env.PROJECT_ROOT || defaultProjectRoot();
  const resolved = path.resolve(__dirname, raw);
  return fs.existsSync(resolved) ? resolved : process.cwd();
}

function resolveRequestedProjectRoot(rawProjectRoot) {
  const raw = String(rawProjectRoot || "").trim();
  if (!raw) return DEFAULT_PROJECT_ROOT;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(DEFAULT_PROJECT_ROOT, raw);
  if (!fs.existsSync(resolved)) throw new Error(`Project root does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Project root is not a directory: ${resolved}`);
  return resolved;
}

function normalizeOptionalModel(rawModel, fallback = "") {
  const value = String(rawModel ?? fallback ?? "").trim();
  if (!value || value === "default") return "";
  return value;
}

// Claude CLI --effort only accepts these. "ultracode" is an interactive-session
// setting and cannot be passed to headless `claude -p`, so it is intentionally absent.
const VALID_CLAUDE_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeEffort(rawEffort) {
  const value = String(rawEffort ?? "").trim().toLowerCase();
  return VALID_CLAUDE_EFFORT.has(value) ? value : "";
}

function defaultProjectRoot() {
  const cwdBase = path.basename(process.cwd());
  if (cwdBase === TOOL_NAME) return "..";
  if (path.basename(__dirname) === TOOL_NAME) return "..";
  return process.cwd();
}

function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

async function streamDebate(req, res) {
  activeDebates += 1;
  const body = await readJsonBody(req);
  const question = String(body.question || "").trim();
  const rounds = clamp(Number(body.rounds || 2), 1, 4);
  const maxFiles = clamp(Number(body.maxFiles || MAX_CONTEXT_FILES), 1, 20);
  const extraPaths = Array.isArray(body.extraPaths) ? body.extraPaths.map(String) : [];
  const style = String(body.style || "balanced");
  const claudeModel = normalizeOptionalModel(body.claudeModel, CLAUDE_MODEL);
  const claudeEffort = normalizeEffort(body.claudeEffort);
  const codexModel = normalizeOptionalModel(body.codexModel);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const write = (type, payload = {}) => {
    res.write(`${JSON.stringify({ type, ...payload })}\n`);
  };

  try {
    if (!question) throw new Error("질문을 입력해줘.");
    const activeProjectRoot = resolveRequestedProjectRoot(body.projectRoot);
    const session = {
      id: makeSessionId(),
      createdAt: new Date().toISOString(),
      question,
      projectRoot: activeProjectRoot,
      rounds,
      style,
      codexModel: codexModel || "default",
      claudeModel: claudeModel || "default",
      claudeEffort: claudeEffort || "default",
      pinned: false,
      context: [],
      turns: [],
      judge: null,
    };
    validateProviderConfig();

    write("status", { message: "관련 프로젝트 파일을 찾는 중..." });
    const contextFiles = scanContext(question, { maxFiles, extraPaths, projectRoot: activeProjectRoot });
    session.context = contextFiles.map(({ path: filePath, score, reason, excerpt }) => ({
      path: filePath,
      score,
      reason,
      chars: excerpt.length,
    }));
    write("context", { files: session.context });

    const contextBlock = buildContextBlock(contextFiles);
    const transcript = [];

    for (let round = 1; round <= rounds; round += 1) {
      write("status", { message: `라운드 ${round}: Codex 의견 생성 중...` });
      const codexText = await callCodexAgent({
        projectRoot: activeProjectRoot,
        model: codexModel,
        instructions: buildCodexInstructions(style),
        input: buildAgentPrompt({
          agentName: "Codex",
          question,
          contextBlock,
          transcript,
          round,
          totalRounds: rounds,
        }),
      });
      const codexTurn = { agent: "Codex", round, text: codexText };
      transcript.push(codexTurn);
      session.turns.push(codexTurn);
      write("turn", codexTurn);

      write("status", { message: `라운드 ${round}: Claude 반박/보완 생성 중...` });
      const claudeText = await callClaudeAgent({
        projectRoot: activeProjectRoot,
        model: claudeModel,
        effort: claudeEffort,
        system: buildClaudeInstructions(style),
        input: buildAgentPrompt({
          agentName: "Claude",
          question,
          contextBlock,
          transcript,
          round,
          totalRounds: rounds,
        }),
      });
      const claudeTurn = { agent: "Claude", round, text: claudeText };
      transcript.push(claudeTurn);
      session.turns.push(claudeTurn);
      write("turn", claudeTurn);
    }

    write("status", { message: "Judge가 합의점과 액션아이템을 정리하는 중..." });
    const judgeText = await callCodexAgent({
      projectRoot: activeProjectRoot,
      model: codexModel,
      instructions: buildJudgeInstructions(),
      input: buildJudgePrompt({ question, contextBlock, transcript }),
    });
    session.judge = { agent: "Judge", text: judgeText };
    write("judge", session.judge);

    saveSession(session);
    write("done", { sessionId: session.id });
  } catch (error) {
    write("error", { message: error.message || String(error) });
  } finally {
    activeDebates = Math.max(0, activeDebates - 1);
    scheduleShutdownIfIdle();
    res.end();
  }
}

async function selectRootFolder(req, res) {
  try {
    const body = await readJsonBody(req);
    const initialPath = resolvePickerInitialPath(body.initialPath);
    const selectedPath = await runWindowsFolderPicker(initialPath);
    if (!selectedPath) return sendJson(res, { ok: false, cancelled: true });
    if (!fs.existsSync(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
      return sendJson(res, { ok: false, error: `Selected path is not a directory: ${selectedPath}` }, 400);
    }
    sendJson(res, { ok: true, path: selectedPath });
  } catch (error) {
    sendJson(res, { ok: false, error: error.message || String(error) }, 500);
  }
}

function resolvePickerInitialPath(rawInitialPath) {
  const raw = String(rawInitialPath || "").trim();
  if (!raw) return DEFAULT_PROJECT_ROOT;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(DEFAULT_PROJECT_ROOT, raw);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : DEFAULT_PROJECT_ROOT;
}

async function runWindowsFolderPicker(initialPath) {
  if (process.platform !== "win32") throw new Error("Folder picker is currently implemented for Windows only.");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select project root for Project Decision Hub'
$dialog.ShowNewFolderButton = $false
$initial = @'
${initialPath}
'@
if ($initial -and [System.IO.Directory]::Exists($initial)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runCli(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    "",
    DEFAULT_PROJECT_ROOT,
  );
  return stripAnsi(result.stdout).trim();
}

setInterval(() => {
  pruneInactiveClients();
  scheduleShutdownIfIdle();
}, Math.max(5000, CLIENT_HEARTBEAT_TTL_MS)).unref();

function countActiveClients() {
  pruneInactiveClients();
  return activeClients.size;
}

function pruneInactiveClients() {
  const now = Date.now();
  for (const [clientId, lastSeen] of activeClients.entries()) {
    if (now - lastSeen > CLIENT_HEARTBEAT_TTL_MS) activeClients.delete(clientId);
  }
}

function scheduleShutdownIfIdle() {
  if (!AUTO_SHUTDOWN_ON_IDLE || !hasSeenClient) return;
  pruneInactiveClients();
  if (activeClients.size > 0 || activeDebates > 0 || shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    pruneInactiveClients();
    if (activeClients.size > 0 || activeDebates > 0) return;
    console.log(`No browser clients remain. Shutting down Project Decision Hub.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }, AUTO_SHUTDOWN_GRACE_MS);
  shutdownTimer.unref();
}

function cancelShutdownTimer() {
  if (!shutdownTimer) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
}

function scanContext(question, options = {}) {
  const maxFiles = options.maxFiles || MAX_CONTEXT_FILES;
  const extraPaths = options.extraPaths || [];
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const candidates = listCandidateFiles(projectRoot);
  const terms = extractTerms(question);
  const hintedPaths = topicHintPaths(question);
  const forced = readExtraPaths(extraPaths, projectRoot);
  const scored = [];

  for (const filePath of candidates) {
    const rel = slash(path.relative(projectRoot, filePath));
    const ext = path.extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 512 * 1024) continue;

    const pathLower = rel.toLowerCase();
    let score = 0;
    const reasons = [];

    for (const term of terms) {
      if (pathLower.includes(term.toLowerCase())) {
        score += 12;
        reasons.push(`path:${term}`);
      }
    }

    for (const hint of hintedPaths) {
      if (pathLower.includes(hint)) {
        score += 10;
        reasons.push(`topic:${hint}`);
      }
    }

    const text = readFileSlice(filePath, MAX_FILE_CHARS);
    const textLower = text.toLowerCase();
    for (const term of terms) {
      const count = countOccurrences(textLower, term.toLowerCase());
      if (count > 0) {
        score += Math.min(18, count * 2);
        reasons.push(`content:${term}`);
      }
    }

    if (isPriorityDoc(rel)) {
      score += 4;
      reasons.push("priority-doc");
    }

    if (score > 0) {
      scored.push({
        path: rel,
        absPath: filePath,
        score,
        reason: unique(reasons).slice(0, 6).join(", "),
        excerpt: text,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const selected = [...forced];
  const selectedPaths = new Set(selected.map((item) => item.path));
  let totalChars = selected.reduce((sum, item) => sum + item.excerpt.length, 0);

  for (const item of scored) {
    if (selected.length >= maxFiles) break;
    if (selectedPaths.has(item.path)) continue;
    if (totalChars + item.excerpt.length > MAX_CONTEXT_CHARS && selected.length > 0) continue;
    selected.push(item);
    selectedPaths.add(item.path);
    totalChars += item.excerpt.length;
  }

  if (selected.length === 0) {
    const fallback = candidates
      .filter((filePath) => isPriorityDoc(slash(path.relative(projectRoot, filePath))))
      .slice(0, maxFiles)
      .map((filePath) => ({
        path: slash(path.relative(projectRoot, filePath)),
        absPath: filePath,
        score: 1,
        reason: "fallback",
        excerpt: readFileSlice(filePath, MAX_FILE_CHARS),
      }));
    return fallback;
  }

  return selected;
}

function listCandidateFiles(projectRoot) {
  const rg = spawnSync("rg", ["--files"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (rg.status === 0 && rg.stdout) {
    return rg.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((rel) => path.join(projectRoot, rel))
      .filter((filePath) => !hasIgnoredPart(filePath, projectRoot));
  }

  return walkFiles(projectRoot, projectRoot).filter((filePath) => !hasIgnoredPart(filePath, projectRoot));
}

function walkFiles(root, projectRoot = root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (hasIgnoredPart(filePath, projectRoot)) continue;
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile()) out.push(filePath);
    }
  }
  return out;
}

function hasIgnoredPart(filePath, projectRoot) {
  const rel = path.relative(projectRoot, filePath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.some((part) => IGNORE_PARTS.has(part) || part.startsWith("steamworks_sdk_"));
}

function readExtraPaths(extraPaths, projectRoot) {
  const out = [];
  for (const raw of extraPaths) {
    const clean = raw.trim();
    if (!clean) continue;
    const absPath = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(projectRoot, clean);
    if (!isInsideRoot(absPath, projectRoot)) continue;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
    out.push({
      path: slash(path.relative(projectRoot, absPath)),
      absPath,
      score: 999,
      reason: "manual",
      excerpt: readFileSlice(absPath, MAX_FILE_CHARS),
    });
  }
  return out;
}

function readFileSlice(filePath, maxChars) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[...truncated ${text.length - maxChars} chars...]`;
  } catch {
    return "";
  }
}

function extractTerms(text) {
  const raw = text.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "지금",
    "현재",
    "생각",
    "어떻게",
    "해야",
    "하는",
    "같아",
    "같은",
    "있어",
    "있나",
  ]);
  return unique(raw.map((item) => item.toLowerCase()).filter((item) => !stop.has(item))).slice(0, 24);
}

function topicHintPaths(question) {
  const lower = question.toLowerCase();
  const out = [];
  for (const hint of TOPIC_HINTS) {
    if (hint.terms.some((term) => lower.includes(term.toLowerCase()))) {
      out.push(...hint.paths);
    }
  }
  return unique(out);
}

function isPriorityDoc(relPath) {
  const lower = relPath.toLowerCase();
  return (
    lower === "readme.md" ||
    lower.includes("remaining_work") ||
    lower.includes("market_analysis") ||
    lower.includes("game_design") ||
    lower.includes("roadmap") ||
    lower.includes("design") ||
    lower.includes("balance")
  );
}

function buildContextBlock(files) {
  if (!files.length) return "No repository context was selected.";
  return files
    .map((file, index) => {
      return `### Context File ${index + 1}: ${file.path}\nReason: ${file.reason || "selected"}\n\n\`\`\`\n${file.excerpt}\n\`\`\``;
    })
    .join("\n\n");
}

function buildCodexInstructions(style) {
  return [
    "You are Codex inside a project decision debate tool.",
    "Answer in Korean unless the user explicitly asks otherwise.",
    "Act like a senior engineering/product collaborator: concrete, repo-grounded, implementation-aware, and decisive.",
    "Use the provided repository context as ground truth. When context is insufficient, say what is uncertain instead of inventing.",
    "Your role differs from Claude: focus on architecture, code impact, sequencing, verification, and practical execution.",
    "Do not be agreeable by default. Point out risks and tradeoffs clearly.",
    styleInstruction(style),
  ].join("\n");
}

function buildClaudeInstructions(style) {
  return [
    "You are Claude inside a project decision debate tool.",
    "Answer in Korean unless the user explicitly asks otherwise.",
    "Act as a thoughtful counterweight: test assumptions, identify overclaims, product risks, player/user perception, and hidden costs.",
    "Use the provided repository context as ground truth. When context is insufficient, say what is uncertain instead of inventing.",
    "Your role differs from Codex: focus on premise checking, design judgment, market/review risk, and alternative framing.",
    "Do not merely repeat Codex. Engage with its specific claims and improve or challenge them.",
    styleInstruction(style),
  ].join("\n");
}

function buildJudgeInstructions() {
  return [
    "You are the Judge/Synthesizer in a project decision debate.",
    "Answer in Korean.",
    "Do not add a third independent essay. Synthesize the debate into a decision aid.",
    "Structure the answer with short sections: 결론, 합의점, 남은 쟁점, 추천 액션.",
    "Be clear about confidence and what repository facts support the conclusion.",
  ].join("\n");
}

function styleInstruction(style) {
  if (style === "sharp") {
    return "Style: concise, direct, and critical. Prefer strong recommendations over long hedging.";
  }
  if (style === "exploratory") {
    return "Style: exploratory but still useful. Surface alternatives and unresolved questions.";
  }
  return "Style: readable and discussion-like, similar to a good Codex/Claude chat answer. Avoid bloated reports.";
}

function buildAgentPrompt({ agentName, question, contextBlock, transcript, round, totalRounds }) {
  const transcriptBlock = transcript.length
    ? transcript.map((turn) => `[${turn.agent} R${turn.round}]\n${turn.text}`).join("\n\n")
    : "(No prior turns.)";

  return [
    `User question:\n${question}`,
    "",
    `Debate round: ${round}/${totalRounds}`,
    `You are speaking as: ${agentName}`,
    "",
    "Repository context:",
    contextBlock,
    "",
    "Prior debate transcript:",
    transcriptBlock,
    "",
    "Task:",
    round === 1 && agentName === "Codex"
      ? "Give your initial repo-grounded position. Include concrete recommendation and key risks."
      : "Respond to the prior turns. Correct mistakes, add missing considerations, and move the decision forward.",
  ].join("\n");
}

function buildJudgePrompt({ question, contextBlock, transcript }) {
  const transcriptBlock = transcript.map((turn) => `[${turn.agent} R${turn.round}]\n${turn.text}`).join("\n\n");
  return [
    `User question:\n${question}`,
    "",
    "Repository context:",
    contextBlock,
    "",
    "Debate transcript:",
    transcriptBlock,
    "",
    "Synthesize the practical decision. Keep it readable in a chat UI.",
  ].join("\n");
}

function validateProviderConfig() {
  if (CODEX_PROVIDER === "api" && !env.OPENAI_API_KEY) {
    throw new Error("CODEX_PROVIDER=api 이지만 OPENAI_API_KEY가 .env에 없습니다.");
  }
  if (CLAUDE_PROVIDER === "api" && !env.ANTHROPIC_API_KEY) {
    throw new Error("CLAUDE_PROVIDER=api 이지만 ANTHROPIC_API_KEY가 .env에 없습니다.");
  }
  if (CODEX_PROVIDER === "cli" && !isCommandAvailable(CODEX_CLI_PATH)) {
    throw new Error(`Codex CLI를 찾지 못했습니다: ${CODEX_CLI_PATH}`);
  }
  if (CLAUDE_PROVIDER === "cli" && !isCommandAvailable(CLAUDE_CLI_PATH)) {
    throw new Error(`Claude CLI를 찾지 못했습니다: ${CLAUDE_CLI_PATH}`);
  }
}

async function callCodexAgent({ projectRoot = DEFAULT_PROJECT_ROOT, model = CODEX_MODEL, instructions, input }) {
  if (CODEX_PROVIDER === "api") return callOpenAI({ instructions, input });
  if (CODEX_PROVIDER !== "cli") throw new Error(`지원하지 않는 CODEX_PROVIDER: ${CODEX_PROVIDER}`);
  return callCodexCli({ projectRoot, model, instructions, input });
}

async function callClaudeAgent({ projectRoot = DEFAULT_PROJECT_ROOT, model = CLAUDE_MODEL, effort = "", system, input }) {
  if (CLAUDE_PROVIDER === "api") return callAnthropic({ system, input });
  if (CLAUDE_PROVIDER !== "cli") throw new Error(`지원하지 않는 CLAUDE_PROVIDER: ${CLAUDE_PROVIDER}`);
  return callClaudeCli({ projectRoot, model, effort, system, input });
}

async function callCodexCli({ projectRoot, model, instructions, input }) {
  const outputFile = path.join(SESSIONS_ROOT, `codex-last-${crypto.randomBytes(6).toString("hex")}.txt`);
  const args = [
    "exec",
    "-C",
    projectRoot,
    "-s",
    "read-only",
    "-m",
    model || CODEX_MODEL,
    "--color",
    "never",
    "--ephemeral",
    "-o",
    outputFile,
    "-",
  ];
  const prompt = `${instructions}\n\n${input}`;

  try {
    const result = await runCli(CODEX_CLI_PATH, args, prompt, projectRoot);
    if (fs.existsSync(outputFile)) {
      const text = fs.readFileSync(outputFile, "utf8").trim();
      if (text) return text;
    }
    return cleanCodexStdout(result.stdout).trim();
  } finally {
    safeUnlink(outputFile);
  }
}

async function callClaudeCli({ projectRoot, model, effort, system, input }) {
  const args = ["-p", "-", "--permission-mode", "dontAsk", "--output-format", "text"];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (system) args.push("--system-prompt", system);

  const result = await runCli(CLAUDE_CLI_PATH, args, input, projectRoot);
  const text = stripAnsi(result.stdout).trim();
  if (!text) throw new Error("Claude CLI 응답에서 텍스트를 찾지 못했습니다.");
  return text;
}

function runCli(command, args, input, cwd = DEFAULT_PROJECT_ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`CLI 호출 시간이 초과되었습니다: ${command}`));
    }, CLI_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI 호출 실패(${code}): ${tail(`${stderr}\n${stdout}`, 5000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.write(input, "utf8");
    child.stdin.end();
  });
}

function cleanCodexStdout(text) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const skipped = [
    /^20\d\d-\d\d-\d\dT.*\bWARN\b/,
    /^OpenAI Codex\b/,
    /^-+$/,
    /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/,
    /^user$/,
    /^tokens used$/,
    /^\d[\d,]*$/,
  ];
  return lines.filter((line) => !skipped.some((pattern) => pattern.test(line))).join("\n");
}

function defaultCodexCliPath() {
  const candidate = path.join(process.env.USERPROFILE || "", ".codex", ".sandbox-bin", "codex.exe");
  return fs.existsSync(candidate) ? candidate : "codex";
}

async function callOpenAI({ instructions, input }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
      input,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI API 오류: ${data.error?.message || response.statusText}`);
  }

  const text = data.output_text || extractOpenAIText(data);
  if (!text) throw new Error("OpenAI 응답에서 텍스트를 찾지 못했습니다.");
  return text.trim();
}

function extractOpenAIText(data) {
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callAnthropic({ system, input }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: input }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Anthropic API 오류: ${data.error?.message || response.statusText}`);
  }

  const text = (data.content || [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Anthropic 응답에서 텍스트를 찾지 못했습니다.");
  return text;
}

function saveSession(session) {
  if (!session.logFile) session.logFile = `${session.id}__${slugify(session.question)}.md`;
  const filePath = path.join(SESSIONS_ROOT, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
  writeSessionLog(session);
}

function writeSessionLog(session) {
  fs.mkdirSync(LOGS_ROOT, { recursive: true });
  const logPath = path.join(LOGS_ROOT, path.basename(session.logFile));
  fs.writeFileSync(logPath, renderSessionMarkdown(session), "utf8");
}

function renderSessionMarkdown(session) {
  const out = [];
  // Quote string values so free-text fields (e.g. a custom model name with a ':')
  // can't break the YAML front matter. JSON.stringify yields a valid quoted scalar.
  out.push("---");
  out.push(`id: ${JSON.stringify(session.id ?? "")}`);
  out.push(`created: ${JSON.stringify(session.createdAt ?? "")}`);
  out.push(`pinned: ${session.pinned ? "true" : "false"}`);
  out.push(`rounds: ${Number(session.rounds) || 0}`);
  out.push(`style: ${JSON.stringify(session.style ?? "")}`);
  out.push(`codexModel: ${JSON.stringify(session.codexModel ?? "")}`);
  out.push(`claudeModel: ${JSON.stringify(session.claudeModel ?? "")}`);
  out.push(`claudeEffort: ${JSON.stringify(session.claudeEffort ?? "")}`);
  out.push("---");
  out.push("");

  const questionLines = String(session.question || "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const meaningfulLines = questionLines.filter(Boolean);
  const titleLine = meaningfulLines[0] || "Debate";
  out.push(`# ${session.pinned ? "⭐ " : ""}${titleLine}`);
  out.push("");
  if (meaningfulLines.length > 1) {
    for (const line of meaningfulLines) out.push(`> ${line}`);
    out.push("");
  }
  out.push(`- **Created:** ${session.createdAt}`);
  out.push(`- **Project root:** \`${session.projectRoot}\``);
  out.push(`- **Rounds:** ${session.rounds} · **Tone:** ${session.style}`);
  out.push(
    `- **Models:** Codex=${session.codexModel} · Claude=${session.claudeModel} (effort ${session.claudeEffort})`,
  );
  out.push("");

  out.push("## Context files");
  out.push("");
  if (session.context && session.context.length) {
    for (const file of session.context) {
      const kchars = Math.round((file.chars || 0) / 100) / 10;
      out.push(
        `- \`${file.path}\` — score ${Math.round(file.score || 0)} · ${file.reason || "selected"} · ${kchars}k chars`,
      );
    }
  } else {
    out.push("_None._");
  }
  out.push("");

  out.push("## Debate");
  out.push("");
  for (const turn of session.turns || []) {
    out.push(`### Round ${turn.round} — ${turn.agent}`);
    out.push("");
    out.push(String(turn.text || "").trim());
    out.push("");
  }

  out.push("## Judge — Decision");
  out.push("");
  out.push(session.judge ? String(session.judge.text || "").trim() : "_No judge output._");
  out.push("");

  return out.join("\n");
}

function slugify(text) {
  const base = String(text || "")
    .trim()
    .slice(0, 48)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  return base || "debate";
}

function sanitizeSessionId(id) {
  const raw = String(id || "").trim();
  if (!raw || !/^[A-Za-z0-9_\-]+$/.test(raw)) throw new Error("Invalid session id");
  return raw;
}

function loadSessionById(id) {
  const safeId = sanitizeSessionId(id);
  const jsonPath = path.join(SESSIONS_ROOT, `${safeId}.json`);
  if (!fs.existsSync(jsonPath)) throw new Error("Session not found");
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function setSessionPinned(id, pinned) {
  const session = loadSessionById(id);
  session.pinned = Boolean(pinned);
  saveSession(session);
  return { ok: true, id: session.id, pinned: session.pinned };
}

function deleteSession(id) {
  const safeId = sanitizeSessionId(id);
  fs.rmSync(path.join(SESSIONS_ROOT, `${safeId}.json`), { force: true });
  // Resolve the .md by the ASCII id prefix rather than the stored logFile string:
  // the slug can contain Unicode (e.g. Korean) whose on-disk normalization may
  // not byte-match the stored string, which would make a targeted rmSync silently miss.
  let removed = 0;
  if (fs.existsSync(LOGS_ROOT)) {
    for (const name of fs.readdirSync(LOGS_ROOT)) {
      if (name.startsWith(`${safeId}__`) && name.endsWith(".md")) {
        fs.rmSync(path.join(LOGS_ROOT, name), { force: true });
        removed += 1;
      }
    }
  }
  return { ok: true, id: safeId, removedLogs: removed };
}

function serveSessionLog(id, res) {
  let session;
  try {
    session = loadSessionById(id);
  } catch (error) {
    return sendJson(res, { error: error.message || String(error) }, 404);
  }
  if (!session.logFile) {
    // First read of a pre-feature session: assign + persist so future restarts/backfills are stable.
    session.logFile = `${session.id}__${slugify(session.question)}.md`;
    saveSession(session);
  }
  const logPath = path.join(LOGS_ROOT, path.basename(session.logFile));
  if (!fs.existsSync(logPath)) writeSessionLog(session);
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  fs.createReadStream(logPath).pipe(res);
}

function backfillLogs() {
  if (!fs.existsSync(SESSIONS_ROOT)) return;
  for (const name of fs.readdirSync(SESSIONS_ROOT)) {
    if (!name.endsWith(".json")) continue;
    const jsonPath = path.join(SESSIONS_ROOT, name);
    let session;
    try {
      session = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch {
      continue;
    }
    if (!session.id) continue;
    const expected = session.logFile || `${session.id}__${slugify(session.question)}.md`;
    const logPath = path.join(LOGS_ROOT, path.basename(expected));
    if (session.logFile && fs.existsSync(logPath)) continue;
    session.logFile = path.basename(expected);
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2), "utf8");
      writeSessionLog(session);
    } catch {
      /* best-effort backfill */
    }
  }
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  return fs
    .readdirSync(SESSIONS_ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(SESSIONS_ROOT, name);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return {
          id: data.id,
          createdAt: data.createdAt,
          question: data.question,
          turns: data.turns?.length || 0,
          pinned: Boolean(data.pinned),
          logFile: data.logFile || null,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        String(b.createdAt).localeCompare(String(a.createdAt)),
    );
}

function makeSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function serveStatic(urlPath, res) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(cleanPath);
  const filePath = path.normalize(path.join(STATIC_ROOT, decoded));

  if (!filePath.startsWith(STATIC_ROOT)) {
    return sendJson(res, { error: "Invalid path" }, 400);
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function isRgAvailable() {
  const result = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function isCommandAvailable(command) {
  if (!command) return false;
  if (command.includes("\\") || command.includes("/") || path.isAbsolute(command)) {
    return fs.existsSync(command);
  }
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures for temporary CLI output files.
  }
}

function tail(text, maxChars) {
  const value = String(text || "");
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(term, idx)) !== -1) {
    count += 1;
    idx += term.length;
    if (count > 20) break;
  }
  return count;
}

function unique(items) {
  return [...new Set(items)];
}

function slash(value) {
  return value.replace(/\\/g, "/");
}

function isInsideRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
