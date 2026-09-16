export function imageRequest(config, prompt) {
  if (!config.imageApiUrl || !config.imageModel || !config.imageApiKey) throw new Error('请填写图像 API URL、模型和 Key');
  const url = new URL(config.imageApiUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('图像 API 必须为 HTTP(S) 地址');
  return { url: url.href, body: { model: config.imageModel, prompt, n: 1, size: config.imageSize } };
}

export function imageResultUrl(data) {
  const item = data?.data?.[0];
  if (typeof item?.b64_json === 'string' && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url)) return item.url;
  throw new Error('图像接口未返回 data[0].b64_json 或有效图片 URL');
}

export async function requestCloudImage(config, prompt, signal) {
  const request = imageRequest(config, prompt);
  const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.imageApiKey}` }, body: JSON.stringify(request.body), signal });
  if (!response.ok) throw new Error(`图像 API 请求失败 (${response.status})`);
  const url = imageResultUrl(await response.json());
  // Never forward the provider API key to a returned CDN/image URL.
  const image = await fetch(url, { signal });
  if (!image.ok) throw new Error(`下载生成图片失败 (${image.status})`);
  const bitmap = await createImageBitmap(await image.blob());
  try {
    if (signal.aborted) throw signal.reason;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Centre-crop to the model canvas, avoiding stretched or tiled pixels.
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 512, 512);
    return { rgba: ctx.getImageData(0, 0, 512, 512).data, rawDataUrl: canvas.toDataURL('image/png') };
  } finally { bitmap.close(); }
}
