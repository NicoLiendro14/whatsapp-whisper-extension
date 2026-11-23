import { Buffer } from 'node:buffer';

const DAILY_LIMIT_FREE = 30;
const DAILY_LIMIT_PRO = 500;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID, X-License-Key',
};

// ── Licensing ──
// Polar is the merchant of record and owns the subscription lifecycle, so a
// cancelled or refunded subscription simply stops validating. The cache TTL is
// how long a revoked key keeps working, not a correctness window.

async function checkLicense(env, key) {
  if (!key || !env.POLAR_TOKEN) return false;

  const cacheKey = `lic:${key}`;
  const cached = await env.RATE_LIMIT.get(cacheKey);
  if (cached !== null) return cached === '1';

  let granted = false;
  try {
    const r = await fetch(`${env.POLAR_API_BASE}/v1/license-keys/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.POLAR_TOKEN}`
      },
      body: JSON.stringify({ key, organization_id: env.POLAR_ORG_ID })
    });
    const data = await r.json().catch(() => null);
    granted = r.ok && data?.status === 'granted';
  } catch (err) {
    // Polar unreachable: fail closed to the free tier rather than handing out
    // pro limits, but don't cache the outcome — it isn't an answer about the key.
    console.error('License validation failed:', err);
    return false;
  }

  // Negative answers are cached briefly so a typo'd key can't hammer Polar.
  await env.RATE_LIMIT.put(cacheKey, granted ? '1' : '0', {
    expirationTtl: granted ? 86400 : 600
  });
  return granted;
}

// Pro quota follows the licence, not the device: ten people sharing one key
// share one budget, so sharing throttles itself instead of multiplying cost.
function usageKey(clientId, licenseKey) {
  const today = new Date().toISOString().slice(0, 10);
  return licenseKey
    ? `usage:lic:${licenseKey}:${today}`
    : `usage:${clientId}:${today}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === '/transcribe') {
      return handleTranscribe(request, env);
    }

    if (url.pathname === '/usage') {
      return handleUsage(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};

async function handleTranscribe(request, env) {
  const clientId = request.headers.get('X-Client-ID');
  if (!clientId || clientId.length < 10) {
    return jsonResponse({ error: 'Missing or invalid client ID' }, 401);
  }

  const licenseKey = request.headers.get('X-License-Key');
  const isPro = await checkLicense(env, licenseKey);
  const key = usageKey(clientId, isPro ? licenseKey : null);

  const { used, limit, remaining } = await getUsage(env, key, isPro);

  if (remaining <= 0) {
    return jsonResponse({
      error: isPro
        ? `Monthly limit reached (${limit}). Get in touch if you need more.`
        : 'Daily free limit reached. Upgrade to Pro for more transcriptions.',
      code: 'DAILY_LIMIT',
      pro: isPro,
      used,
      limit,
      remaining: 0
    }, 429);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Invalid request body. Expected multipart form data.' }, 400);
  }

  const audioFile = formData.get('file');
  if (!audioFile) {
    return jsonResponse({ error: 'No audio file provided' }, 400);
  }

  if (audioFile.size > 25 * 1024 * 1024) {
    return jsonResponse({ error: 'Audio file too large (max 25 MB)' }, 400);
  }

  try {
    const audioBytes = await audioFile.arrayBuffer();
    const base64 = Buffer.from(audioBytes).toString('base64');

    const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64,
    });

    const newUsed = await incrementUsage(env, key);

    // Word timestamps are the paid feature, so they are withheld here rather
    // than hidden in the UI - without a licence the data never leaves the server.
    const words = result.segments?.flatMap(s => s.words || []) || [];

    return jsonResponse({
      success: true,
      text: result.text,
      language: result.transcription_info?.language || null,
      words: isPro && words.length ? words : null,
      pro: isPro,
      used: newUsed,
      limit,
      remaining: limit - newUsed
    });

  } catch (err) {
    console.error('Transcription error:', err);
    return jsonResponse({
      error: 'Transcription failed: ' + (err.message || 'Unknown error'),
      code: 'TRANSCRIPTION_ERROR'
    }, 500);
  }
}

async function handleUsage(request, env) {
  const clientId = request.headers.get('X-Client-ID');
  if (!clientId || clientId.length < 10) {
    return jsonResponse({ error: 'Missing or invalid client ID' }, 401);
  }

  const licenseKey = request.headers.get('X-License-Key');
  const isPro = await checkLicense(env, licenseKey);

  const usage = await getUsage(env, usageKey(clientId, isPro ? licenseKey : null), isPro);
  // The popup mirrors this: pro status is decided here, never client-side.
  return jsonResponse({ ...usage, pro: isPro });
}

async function getUsage(env, key, isPro = false) {
  const limit = isPro ? DAILY_LIMIT_PRO : DAILY_LIMIT_FREE;
  const used = parseInt(await env.RATE_LIMIT.get(key) || '0');
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used)
  };
}

async function incrementUsage(env, key) {
  const current = parseInt(await env.RATE_LIMIT.get(key) || '0');
  const newCount = current + 1;
  await env.RATE_LIMIT.put(key, String(newCount), { expirationTtl: 86400 });
  return newCount;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}
