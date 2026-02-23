import { Buffer } from 'node:buffer';

const DAILY_LIMIT_FREE = 30;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID',
};

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

  const { used, limit, remaining } = await getUsage(env, clientId);

  if (remaining <= 0) {
    return jsonResponse({
      error: 'Daily limit reached. Add your own OpenAI API key for unlimited transcriptions.',
      code: 'DAILY_LIMIT',
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

    const newUsed = await incrementUsage(env, clientId);

    return jsonResponse({
      success: true,
      text: result.text,
      language: result.language || null,
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

  const usage = await getUsage(env, clientId);
  return jsonResponse(usage);
}

async function getUsage(env, clientId) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `usage:${clientId}:${today}`;
  const used = parseInt(await env.RATE_LIMIT.get(key) || '0');
  return {
    used,
    limit: DAILY_LIMIT_FREE,
    remaining: Math.max(0, DAILY_LIMIT_FREE - used)
  };
}

async function incrementUsage(env, clientId) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `usage:${clientId}:${today}`;
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
