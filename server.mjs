import express from 'express';

const PORT = parseInt(process.env.PORT || '7030', 10);
const HOST = process.env.HOST || '0.0.0.0';

import fs from 'fs';
import os from 'os';
import path from 'path';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
let OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const TARGET_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'main';

const TELEGRAM_TARGET = process.env.TELEGRAM_TARGET || '451330600';
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'telegram';

const CHECK_EVERY_MS = Number(process.env.CHECK_EVERY_MS || '60000');
const STATE_PATH = process.env.STATE_PATH || path.join(process.cwd(), 'state.local.json');

function readGatewayTokenFromConfig() {
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(p)) return '';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const mode = j?.gateway?.auth?.mode;
    if (mode === 'password') return j?.gateway?.auth?.password || '';
    return j?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

if (!OPENCLAW_TOKEN) OPENCLAW_TOKEN = readGatewayTokenFromConfig();
if (!OPENCLAW_TOKEN) {
  console.warn('[codex-limit-ui] WARNING: no gateway auth secret found (env OPENCLAW_TOKEN or ~/.openclaw/openclaw.json).');
}

function loadLocalState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { pushEnabled: false };
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { pushEnabled: !!j.pushEnabled };
  } catch {
    return { pushEnabled: false };
  }
}

function saveLocalState(patch) {
  const next = { ...loadLocalState(), ...patch };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const localState = loadLocalState();

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

async function invokeTool(tool, args) {
  const r = await fetch(`${OPENCLAW_URL}/tools/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tool, args }),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: text };
  }
  if (!r.ok) {
    const err = new Error(`tool invoke failed ${r.status}`);
    err.status = r.status;
    err.payload = json;
    throw err;
  }
  return json;
}

function extractStatusText(resultJson) {
  try {
    const blocks = resultJson?.result?.content;
    if (!Array.isArray(blocks)) return '';
    const t = blocks.find((b) => b?.type === 'text' && b?.text)?.text;
    return t || '';
  } catch {
    return '';
  }
}

function parseUsageLine(statusText) {
  const m = String(statusText || '').match(
    /Usage:\s*5h\s*(\d+)%\s*left\s*([^·]+)·\s*Day\s*(\d+)%\s*left\s*(.*)$/m
  );
  if (!m) return null;
  return {
    pct5h: parseInt(m[1], 10),
    time5h: m[2].trim(),
    pctDay: parseInt(m[3], 10),
    timeDay: m[4].trim(),
  };
}

function formatSummary(statusJson) {
  const statusText = extractStatusText(statusJson);
  const parsed = parseUsageLine(statusText);
  if (parsed) {
    return (
      `Codex limits:\n` +
      `- 5h remaining: ${parsed.pct5h}% (${parsed.time5h})\n` +
      `- Day remaining: ${parsed.pctDay}% (${parsed.timeDay})`
    );
  }
  return statusText ? `Codex limits (raw):\n${statusText}` : 'Codex limits: (no status text)';
}

const cache = {
  ok: false,
  lastCheckedMs: 0,
  statusJson: null,
  error: null,
};

let _polling = false;
async function pollNow({ reason } = {}) {
  if (_polling) return;
  _polling = true;
  try {
    if (!OPENCLAW_TOKEN) throw new Error('Gateway auth not configured on server');

    const statusJson = await invokeTool('session_status', { sessionKey: TARGET_SESSION_KEY });
    cache.ok = true;
    cache.lastCheckedMs = Date.now();
    cache.statusJson = statusJson;
    cache.error = null;

    if (localState.pushEnabled) {
      const summary = formatSummary(statusJson);
      await invokeTool('message', {
        action: 'send',
        channel: TELEGRAM_CHANNEL,
        target: TELEGRAM_TARGET,
        message: summary,
        silent: true,
      });
      console.log(`[codex-limit-ui] pushed to telegram (${reason || 'interval'})`);
    }
  } catch (e) {
    cache.ok = false;
    cache.lastCheckedMs = Date.now();
    cache.statusJson = null;
    cache.error = String(e?.message || e);
    console.warn('[codex-limit-ui] poll failed:', cache.error);
  } finally {
    _polling = false;
  }
}

// Background polling (server-side)
setInterval(() => pollNow({ reason: 'interval' }), Math.max(15000, CHECK_EVERY_MS));
// First poll at startup
pollNow({ reason: 'startup' });

app.get('/api/status', async (req, res) => {
  // Return cached result fast.
  // If stale, trigger a background refresh but still return last known.
  const age = Date.now() - (cache.lastCheckedMs || 0);
  if (age > CHECK_EVERY_MS * 2) pollNow({ reason: 'stale' });

  return res.json({
    ok: cache.ok,
    lastCheckedMs: cache.lastCheckedMs,
    error: cache.error,
    status: cache.statusJson,
    pushEnabled: !!localState.pushEnabled,
    checkEveryMs: CHECK_EVERY_MS,
  });
});

app.post('/api/push', express.json({ limit: '10kb' }), (req, res) => {
  const enabled = !!req.body?.enabled;
  localState.pushEnabled = enabled;
  saveLocalState({ pushEnabled: enabled });
  return res.json({ ok: true, pushEnabled: enabled });
});

app.post('/api/poll-now', (req, res) => {
  pollNow({ reason: 'manual' });
  return res.json({ ok: true });
});

app.use(express.static(new URL('./public', import.meta.url).pathname));

app.listen(PORT, HOST, () => {
  console.log(`[codex-limit-ui] http://${HOST}:${PORT}`);
  console.log(`[codex-limit-ui] gateway=${OPENCLAW_URL} sessionKey=${TARGET_SESSION_KEY}`);
  console.log(`[codex-limit-ui] checkEveryMs=${CHECK_EVERY_MS} pushEnabled=${localState.pushEnabled}`);
});
