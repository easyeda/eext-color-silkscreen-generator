import { DEFAULT_MODEL_MANIFEST, validateManifest, validateModelPaths } from './local-core';
import type { LocalModelManifest } from './local-core';
import { STANDARD_MODEL_MANIFEST } from './standard-model';

export function isInpainting(manifest: LocalModelManifest): boolean {
	return manifest.pipeline ? manifest.pipeline === 'inpainting' : manifest.files.some(file => file.path === 'vae_encoder/model.onnx');
}

export function pipelineFromIndex(index: { _class_name?: string }): 'inpainting' | 'text-to-image' {
	if (/Inpaint/i.test(index._class_name || '')) return 'inpainting';
	if (/StableDiffusionPipeline/.test(index._class_name || '')) return 'text-to-image';
	throw new Error('仅支持 Stable Diffusion 普通生图或 Inpainting 模型');
}

export function httpUrl(value: string): URL {
	const url = new URL(value);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 HTTP(S) 地址，不能包含用户名或密码');
	return url;
}

async function sha256(data: ArrayBuffer): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function resolveRemoteModel(preset: string, link: string, mirror: string, signal?: AbortSignal): Promise<LocalModelManifest> {
	if (preset === 'inpainting') return DEFAULT_MODEL_MANIFEST;
	if (preset === 'standard') return STANDARD_MODEL_MANIFEST;
	const url = httpUrl(link);
	if (url.pathname.endsWith('.json')) {
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`模型清单获取失败: ${response.status}`);
		const manifest = validateManifest(await response.json());
		if (!['inpainting', 'text-to-image'].includes(manifest.pipeline || '')) throw new Error('自定义清单必须声明 pipeline: inpainting 或 text-to-image');
		validateModelPaths(manifest.files.map(file => file.path));
		if (manifest.baseUrl) httpUrl(manifest.baseUrl);
		return { ...manifest, id: `custom-${(await sha256(new TextEncoder().encode(JSON.stringify(manifest)).buffer)).slice(0, 20)}` };
	}
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length < 2 || (parts.length > 2 && parts[2] !== 'tree')) throw new Error('请输入模型仓库链接（owner/model），或 manifest.json 链接');
	const repository = parts.slice(0, 2).join('/');
	const revision = parts.length > 3 ? parts.slice(3).join('/') : 'main';
	const root = httpUrl(mirror).href.replace(/\/+$/, '');
	const response = await fetch(`${root}/api/models/${repository}/revision/${encodeURIComponent(revision)}?blobs=true`, { signal });
	if (!response.ok) throw new Error(`读取模型仓库失败: ${response.status}`);
	const metadata = await response.json();
	if (!/^[a-f0-9]{40}$/.test(metadata.sha)) throw new Error('无法固定模型 revision');
	const wanted = /^(model_index\.json|scheduler\/scheduler_config\.json|tokenizer\/(merges\.txt|vocab\.json|special_tokens_map\.json|tokenizer_config\.json)|text_encoder\/model\.onnx|vae_(encoder|decoder)\/model\.onnx|unet\/(model\.onnx|model\.onnx_data|weights\.pb))$/;
	const files = [];
	let pipeline: 'inpainting' | 'text-to-image' | undefined;
	for (const item of metadata.siblings.filter((file: any) => wanted.test(file.rfilename))) {
		let hash = item.lfs?.sha256;
		if (!hash) {
			if (item.size > 2 * 1024 * 1024) throw new Error(`大文件缺少 SHA-256: ${item.rfilename}`);
			const file = await fetch(`${root}/${repository}/resolve/${metadata.sha}/${item.rfilename}`, { signal });
			if (!file.ok) throw new Error(`读取文件失败: ${item.rfilename}`);
			const bytes = await file.arrayBuffer();
			hash = await sha256(bytes);
			if (item.rfilename === 'model_index.json') pipeline = pipelineFromIndex(JSON.parse(new TextDecoder().decode(bytes)));
		}
		files.push({ path: item.rfilename, size: item.size, sha256: hash });
	}
	validateModelPaths(files.map(file => file.path));
	if (!pipeline) throw new Error('无法从 model_index.json 识别模型类型');
	if (pipeline === 'inpainting' && !files.some(file => file.path === 'vae_encoder/model.onnx')) throw new Error('Inpainting 缺少 VAE encoder');
	return validateManifest({ schemaVersion: 1, id: `custom-${(await sha256(new TextEncoder().encode(repository + metadata.sha).buffer)).slice(0, 20)}`, displayName: repository, repository, revision: metadata.sha, license: metadata.cardData?.license || '请查阅模型仓库许可证', resolution: 512, dtype: 'fp32', pipeline, files });
}
