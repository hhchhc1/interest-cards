// Vercel Serverless Function：梦境生图代理
// 默认使用智谱 CogView-3-Flash（免费、不限调用次数）
// 环境变量：
//   ZHIPU_API_KEY  必填（DREAM_PROVIDER=zhipu 时）
//   ARK_API_KEY    可选（DREAM_PROVIDER=ark 时，火山方舟豆包 Seedream，按张计费）
//   DREAM_PROVIDER 可选：zhipu（默认）| ark
const cache = new Map();
const CACHE_LIMIT = 50;
const CACHE_TTL = 1000 * 60 * 60 * 6;

const PROVIDERS = {
  zhipu: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    model: process.env.ZHIPU_MODEL || 'cogview-3-flash',
    size: '1152x864',
    fallbackSize: '1024x1024'
  },
  ark: {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    model: process.env.ARK_MODEL || 'doubao-seedream-5-0-lite',
    size: '1K',
    fallbackSize: '1K'
  }
};

function buildPrompt(dream) {
  return [
    '梦境插画，超现实主义风格。',
    `梦境内容：${dream}。`,
    '电影感光影，柔和雾气，梦幻色调，细腻笔触，构图完整，没有文字。'
  ].join('');
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function toDataUrl(item) {
  if (item.b64_json) return `data:image/jpeg;base64,${item.b64_json}`;
  if (!item.url) return null;
  const imageResponse = await fetch(item.url);
  if (!imageResponse.ok) return null;
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  const type = imageResponse.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${buffer.toString('base64')}`;
}

async function generate(provider, apiKey, prompt, size) {
  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      prompt,
      size,
      watermark: false
    })
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const providerName = (process.env.DREAM_PROVIDER || 'zhipu').toLowerCase();
  const provider = PROVIDERS[providerName] || PROVIDERS.zhipu;
  const apiKey = providerName === 'ark' ? process.env.ARK_API_KEY : process.env.ZHIPU_API_KEY;

  if (req.method === 'GET') {
    return send(res, 200, { ok: true, configured: Boolean(apiKey), provider: providerName, model: provider.model });
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method_not_allowed' });
  }
  if (!apiKey) {
    return send(res, 500, {
      error: 'server_not_configured',
      message: providerName === 'ark' ? '缺少 ARK_API_KEY 环境变量' : '缺少 ZHIPU_API_KEY 环境变量'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (error) { body = null; }
  }
  const dream = body && typeof body.dream === 'string' ? body.dream.trim().slice(0, 300) : '';
  if (!dream) {
    return send(res, 400, { error: 'empty_dream' });
  }

  const cached = cache.get(dream);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return send(res, 200, { image: cached.image, cached: true });
  }

  const prompt = buildPrompt(dream);
  try {
    let { response, data } = await generate(provider, apiKey, prompt, provider.size);
    if (!response.ok && provider.fallbackSize !== provider.size) {
      ({ response, data } = await generate(provider, apiKey, prompt, provider.fallbackSize));
    }
    if (!response.ok) {
      return send(res, 502, {
        error: 'upstream_error',
        status: response.status,
        message: (data && (data.error && data.error.message || data.message)) || '图片生成失败'
      });
    }
    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    const image = item ? await toDataUrl(item) : null;
    if (!image) {
      return send(res, 502, { error: 'no_image', message: '模型未返回图片' });
    }

    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(dream, { image, time: Date.now() });
    return send(res, 200, { image });
  } catch (error) {
    return send(res, 504, { error: 'timeout_or_network', message: '生成超时，请稍后重试' });
  }
};

module.exports.config = { maxDuration: 60 };
