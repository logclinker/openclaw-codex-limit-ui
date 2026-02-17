import express from 'express';

const PORT = parseInt(process.env.PORT || '7030', 10);
const HOST = process.env.HOST || '0.0.0.0';

import fs from 'fs';
import os from 'os';
import path from 'path';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
let OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const TARGET_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'main';

function readGatewayTokenFromConfig() {
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(p)) return '';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    // common shapes:
    // gateway.auth.token
    // gateway.auth.password (if mode=password)
    const mode = j?.gateway?.auth?.mode;
    if (mode === 'password') return j?.gateway?.auth?.password || '';
    return j?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

if (!OPENCLAW_TOKEN) {
  OPENCLAW_TOKEN = readGatewayTokenFromConfig();
}

if (!OPENCLAW_TOKEN) {
  console.warn('[codex-limit-ui] WARNING: no gateway auth secret found (env OPENCLAW_TOKEN or ~/.openclaw/openclaw.json). /api/status will 500 until configured.');
}

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
      'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tool, args }),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text }; }
  if (!r.ok) {
    const err = new Error(`tool invoke failed ${r.status}`);
    err.status = r.status;
    err.payload = json;
    throw err;
  }
  return json;
}

app.get('/api/status', async (req, res) => {
  try {
    if (!OPENCLAW_TOKEN) return res.status(500).json({ ok: false, error: 'Gateway auth not configured on server' });
    const json = await invokeTool('session_status', { sessionKey: TARGET_SESSION_KEY });
    return res.json(json);
  } catch (e) {
    return res.status(e.status || 500).json(e.payload || { ok: false, error: String(e?.message || e) });
  }
});

const TELEGRAM_TARGET = process.env.TELEGRAM_TARGET || '451330600';
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'telegram';

function extractStatusText(resultJson) {
  try {
    const blocks = resultJson?.result?.content;
    if (!Array.isArray(blocks)) return '';
    const t = blocks.find(b => b?.type === 'text' && b?.text)?.text;
    return t || '';
  } catch { return ''; }
}

function parseUsageLine(statusText) {
  const m = String(statusText||'').match(/Usage:\s*5h\s*(\d+)%\s*left\s*([^·]+)·\s*Day\s*(\d+)%\s*left\s*(.*)$/m);
  if(!m) return null;
  return { pct5h: parseInt(m[1],10), time5h: m[2].trim(), pctDay: parseInt(m[3],10), timeDay: m[4].trim() };
}

app.post('/api/notify', express.json({ limit: '20kb' }), async (req, res) => {
  try {
    if (!OPENCLAW_TOKEN) return res.status(500).json({ ok: false, error: 'Gateway auth not configured on server' });

    const status = await invokeTool('session_status', { sessionKey: TARGET_SESSION_KEY });
    const statusText = extractStatusText(status);
    const parsed = parseUsageLine(statusText);

    const summary = parsed
      ? `Codex limits:\n- 5h remaining: ${parsed.pct5h}% (${parsed.time5h})\n- Day remaining: ${parsed.pctDay}% (${parsed.timeDay})`
      : `Codex limits (raw):\n${statusText}`;

    await invokeTool('message', {
      action: 'send',
      channel: TELEGRAM_CHANNEL,
      target: TELEGRAM_TARGET,
      message: summary,
      silent: true,
    });

    return res.json({ ok: true, summary });
  } catch (e) {
    return res.status(e.status || 500).json(e.payload || { ok: false, error: String(e?.message || e) });
  }
});

app.use(express.static(new URL('./public', import.meta.url).pathname));

app.listen(PORT, HOST, () => {
  console.log(`[codex-limit-ui] http://${HOST}:${PORT}`);
  console.log(`[codex-limit-ui] gateway=${OPENCLAW_URL} sessionKey=${TARGET_SESSION_KEY}`);
});
