import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = parseInt(process.env.PORT || '7030', 10);
const HOST = process.env.HOST || '0.0.0.0';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
let OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
const TARGET_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || 'main';

const TELEGRAM_TARGET = process.env.TELEGRAM_TARGET || '451330600';
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || 'telegram';

const CHECK_EVERY_MS = Number(process.env.CHECK_EVERY_MS || '60000'); // fallback/default
const STATE_PATH = process.env.STATE_PATH || path.join(process.cwd(), 'state.local.json');

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeState(raw = {}) {
  return {
    pushEnabled: !!raw.pushEnabled,
    notificationIntervalMinutes: clampInt(raw.notificationIntervalMinutes, 1, 180, Math.max(1, Math.round(CHECK_EVERY_MS / 60000))),
    quietHoursEnabled: !!raw.quietHoursEnabled,
    quietHoursStart: clampInt(raw.quietHoursStart, 0, 23, 23),
    quietHoursEnd: clampInt(raw.quietHoursEnd, 0, 23, 8),
    threshold5hPct: clampInt(raw.threshold5hPct, 1, 100, 100),
    thresholdDayPct: clampInt(raw.thresholdDayPct, 1, 100, 100),
    lastPushMs: clampInt(raw.lastPushMs, 0, Number.MAX_SAFE_INTEGER, 0),
    lastPushStatus: typeof raw.lastPushStatus === 'string' ? raw.lastPushStatus : 'never',
  };
}

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
    if (!fs.existsSync(STATE_PATH)) return normalizeState();
    const j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return normalizeState(j);
  } catch {
    return normalizeState();
  }
}

function saveLocalState(patch) {
  const next = normalizeState({ ...localState, ...patch });
  Object.assign(localState, next);
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
  // Fallback if parsing fails
  return statusText ? `Codex limits (raw):\n${statusText}` : 'Codex limits: (no status text)';
}

function isInQuietHours(d = new Date()) {
  if (!localState.quietHoursEnabled) return false;
  const h = d.getHours();
  const start = localState.quietHoursStart;
  const end = localState.quietHoursEnd;
  if (start === end) return true; // full day quiet
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function shouldSendForThreshold(parsed) {
  if (!parsed) return true;
  const hit5h = parsed.pct5h <= localState.threshold5hPct;
  const hitDay = parsed.pctDay <= localState.thresholdDayPct;
  return hit5h || hitDay;
}

const cache = {
  ok: false,
  lastCheckedMs: 0,
  nextCheckMs: 0,
  statusJson: null,
  error: null,
};

let _polling = false;
let _nextTimer = null;

function getIntervalMs() {
  return localState.notificationIntervalMinutes * 60 * 1000;
}

function scheduleNextPoll(reason = 'schedule') {
  if (_nextTimer) clearTimeout(_nextTimer);
  const waitMs = Math.max(15000, getIntervalMs());
  cache.nextCheckMs = Date.now() + waitMs;
  _nextTimer = setTimeout(async () => {
    await pollNow({ reason: 'interval' });
    scheduleNextPoll('post-interval');
  }, waitMs);
  if (reason !== 'post-interval') {
    console.log(`[codex-limit-ui] next poll in ${Math.round(waitMs / 1000)}s (${reason})`);
  }
}

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
      const statusText = extractStatusText(statusJson);
      const parsed = parseUsageLine(statusText);

      if (isInQuietHours()) {
        saveLocalState({ lastPushStatus: 'skipped: quiet hours' });
      } else if (!shouldSendForThreshold(parsed)) {
        saveLocalState({
          lastPushStatus: `skipped: thresholds (5h>${localState.threshold5hPct}% and day>${localState.thresholdDayPct}%)`,
        });
      } else {
        const summary = formatSummary(statusJson);
        await invokeTool('message', {
          action: 'send',
          channel: TELEGRAM_CHANNEL,
          target: TELEGRAM_TARGET,
          message: summary,
          silent: true,
        });
        saveLocalState({ lastPushMs: Date.now(), lastPushStatus: `sent (${reason || 'interval'})` });
        console.log(`[codex-limit-ui] pushed to telegram (${reason || 'interval'})`);
      }
    } else {
      saveLocalState({ lastPushStatus: 'disabled' });
    }
  } catch (e) {
    cache.ok = false;
    cache.lastCheckedMs = Date.now();
    cache.statusJson = null;
    cache.error = String(e?.message || e);
    saveLocalState({ lastPushStatus: `error: ${cache.error}` });
    console.warn('[codex-limit-ui] poll failed:', cache.error);
  } finally {
    _polling = false;
  }
}

// First poll + scheduler startup
pollNow({ reason: 'startup' }).finally(() => scheduleNextPoll('startup'));

app.get('/api/status', async (req, res) => {
  const age = Date.now() - (cache.lastCheckedMs || 0);
  if (age > getIntervalMs() * 2) pollNow({ reason: 'stale' });

  return res.json({
    ok: cache.ok,
    lastCheckedMs: cache.lastCheckedMs,
    nextCheckMs: cache.nextCheckMs,
    error: cache.error,
    status: cache.statusJson,
    pushEnabled: !!localState.pushEnabled,
    checkEveryMs: getIntervalMs(),
    settings: {
      notificationIntervalMinutes: localState.notificationIntervalMinutes,
      quietHoursEnabled: localState.quietHoursEnabled,
      quietHoursStart: localState.quietHoursStart,
      quietHoursEnd: localState.quietHoursEnd,
      threshold5hPct: localState.threshold5hPct,
      thresholdDayPct: localState.thresholdDayPct,
      lastPushMs: localState.lastPushMs,
      lastPushStatus: localState.lastPushStatus,
    },
  });
});

app.post('/api/push', express.json({ limit: '10kb' }), (req, res) => {
  const enabled = !!req.body?.enabled;
  saveLocalState({ pushEnabled: enabled, lastPushStatus: enabled ? 'enabled' : 'disabled' });
  return res.json({ ok: true, pushEnabled: enabled });
});

app.post('/api/settings', express.json({ limit: '10kb' }), (req, res) => {
  const body = req.body || {};
  const next = saveLocalState({
    notificationIntervalMinutes: body.notificationIntervalMinutes,
    quietHoursEnabled: body.quietHoursEnabled,
    quietHoursStart: body.quietHoursStart,
    quietHoursEnd: body.quietHoursEnd,
    threshold5hPct: body.threshold5hPct,
    thresholdDayPct: body.thresholdDayPct,
  });

  scheduleNextPoll('settings-changed');

  return res.json({
    ok: true,
    settings: {
      notificationIntervalMinutes: next.notificationIntervalMinutes,
      quietHoursEnabled: next.quietHoursEnabled,
      quietHoursStart: next.quietHoursStart,
      quietHoursEnd: next.quietHoursEnd,
      threshold5hPct: next.threshold5hPct,
      thresholdDayPct: next.thresholdDayPct,
      lastPushMs: next.lastPushMs,
      lastPushStatus: next.lastPushStatus,
    },
    checkEveryMs: getIntervalMs(),
  });
});

app.post('/api/poll-now', (req, res) => {
  pollNow({ reason: 'manual' }).finally(() => scheduleNextPoll('manual-poll'));
  return res.json({ ok: true });
});

app.post('/api/test-push', async (req, res) => {
  try {
    if (!cache.statusJson) {
      await pollNow({ reason: 'test-refresh' });
    }
    const summary = cache.statusJson ? formatSummary(cache.statusJson) : 'Codex limits: no cached status yet';
    await invokeTool('message', {
      action: 'send',
      channel: TELEGRAM_CHANNEL,
      target: TELEGRAM_TARGET,
      message: `🧪 Test notification\n${summary}`,
      silent: true,
    });
    saveLocalState({ lastPushMs: Date.now(), lastPushStatus: 'sent (test)' });
    return res.json({ ok: true });
  } catch (e) {
    const err = String(e?.message || e);
    saveLocalState({ lastPushStatus: `error: ${err}` });
    return res.status(500).json({ ok: false, error: err });
  }
});

app.use(express.static(new URL('./public', import.meta.url).pathname));

app.listen(PORT, HOST, () => {
  console.log(`[codex-limit-ui] http://${HOST}:${PORT}`);
  console.log(`[codex-limit-ui] gateway=${OPENCLAW_URL} sessionKey=${TARGET_SESSION_KEY}`);
  console.log(
    `[codex-limit-ui] checkEveryMs=${getIntervalMs()} pushEnabled=${localState.pushEnabled} quiet=${localState.quietHoursEnabled ? `${localState.quietHoursStart}:00-${localState.quietHoursEnd}:00` : 'off'}`
  );
});
