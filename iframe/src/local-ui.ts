import { createSHA256 } from 'hash-wasm';
import workerSource from '../local-worker.bundle.txt';
import { DEFAULT_MODEL_MANIFEST, processRgba, stripCommonRoot, totalModelBytes, validateManifest, validateModelPaths } from './local-core';
import type { LocalModelManifest } from './local-core';
import { isInpainting, pipelineFromIndex, resolveRemoteModel as lookupRemoteModel } from './model-sources';

const CACHE_NAME = 'easyeda-color-models-v1';
const ARTWORK_CACHE_NAME = 'easyeda-color-artworks-v1';
const CACHE_ROOT = '/__easyeda_color_models__';
const REGISTRY_KEY = 'easyedaColor.importedModels.v1';

export async function resolveRemoteModel(preset: string, link: string, mirror: string, signal?: AbortSignal): Promise<LocalModelManifest> {
	const cacheKey = `easyedaColor.customManifest.v1:${link.trim()}`;
	if (preset === 'custom') {
		try { const saved = localStorage.getItem(cacheKey); if (saved) return validateManifest(JSON.parse(saved)); } catch { /* Resolve again when storage is unavailable. */ }
	}
	const manifest = await lookupRemoteModel(preset, link, mirror, signal);
	if (preset === 'custom') { try { localStorage.setItem(cacheKey, JSON.stringify(manifest)); } catch { /* Generation can continue without persistent metadata. */ } }
	return manifest;
}

export interface ImportedModelRecord {
	id: string;
	name: string;
	size: number;
	fileCount: number;
	files: Array<{ path: string; size: number; sha256: string }>;
	importedAt: number;
	manifest?: LocalModelManifest;
}

export interface LocalProgress {
	phase: string;
	message?: string;
	file?: string;
	loaded?: number;
	total?: number;
	speed?: number;
	remainingBytes?: number;
	index?: number;
	totalFiles?: number;
	current?: number;
	totalSteps?: number;
}

export interface GenerateLocalOptions {
	prompt: string;
	negativePrompt?: string;
	seed: number;
	steps: number;
	guidance: number;
	backend: 'auto' | 'webgpu' | 'wasm';
	avoidKeepouts: boolean;
	source: { type: 'remote'; mirror: string; manifest?: LocalModelManifest } | { type: 'imported'; modelId: string };
	mask: Uint8Array;
	onProgress?: (progress: LocalProgress) => void;
}

type ResultMessage = { type: string; message?: string; rgba?: ArrayBuffer; seed?: number; steps?: number; backend?: string; unetKernelLayout?: string; vaeBackend?: string; vaeDecodeMode?: string; imageLayout?: string; declaredImageLayout?: string; scheduler?: string; conditioningDelta?: number; differingTokenCount?: number; latentSafeRatio?: number; constraintMode?: string; current?: number; total?: number; phase?: string; file?: string; loaded?: number; speed?: number; remainingBytes?: number; index?: number; totalFiles?: number };

let activeWorker: Worker | undefined;
let activeReject: ((reason?: unknown) => void) | undefined;

function makeWorker(): Worker {
	const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
	const worker = new Worker(url, { type: 'module', name: 'easyeda-color-onnx' });
	URL.revokeObjectURL(url);
	return worker;
}

function request(worker: Worker, type: string, payload: Record<string, unknown>, expected: string, onProgress?: (progress: LocalProgress) => void): Promise<ResultMessage> {
	return new Promise((resolve, reject) => {
		activeReject = reject;
		const listener = (event: MessageEvent<ResultMessage>) => {
			const data = event.data;
			if (data.type === 'progress') onProgress?.({ phase: data.phase || 'work', message: data.message, file: data.file, loaded: data.loaded, total: data.total, speed: data.speed, remainingBytes: data.remainingBytes, index: data.index, totalFiles: data.totalFiles });
			else if (data.type === 'step') onProgress?.({ phase: 'generate', current: data.current, totalSteps: data.total });
			else if (data.type === 'error') {
				worker.removeEventListener('message', listener);
				if (activeReject === reject) activeReject = undefined;
				reject(new Error(data.message || '本地模型错误'));
			}
			else if (data.type === expected) {
				worker.removeEventListener('message', listener);
				if (activeReject === reject) activeReject = undefined;
				resolve(data);
			}
		};
		worker.addEventListener('message', listener);
		worker.addEventListener('error', event => {
			if (activeReject === reject) activeReject = undefined;
			reject(new Error(event.message || '推理 Worker 启动失败'));
		}, { once: true });
		worker.postMessage({ type, payload }, payload.mask instanceof Uint8Array ? [payload.mask.buffer] : []);
	});
}

export async function downloadDefaultModel(mirror: string, onProgress?: (progress: LocalProgress) => void, manifest = DEFAULT_MODEL_MANIFEST): Promise<void> {
	cancelLocal();
	const worker = makeWorker();
	activeWorker = worker;
	try {
		await request(worker, 'download', { source: { type: 'remote', mirror, manifest } }, 'ready', onProgress);
	}
	finally {
		worker.terminate();
		if (activeWorker === worker) activeWorker = undefined;
	}
}

export async function generateLocal(options: GenerateLocalOptions): Promise<{ rawDataUrl: string; rgba: Uint8ClampedArray; seed: number; steps: number; backend: string; unetKernelLayout: string; vaeBackend: string; vaeDecodeMode: string; imageLayout: string; declaredImageLayout: string; scheduler: string; conditioningDelta: number; differingTokenCount: number; latentSafeRatio: number; constraintMode: string }> {
	cancelLocal();
	const attempt = async (requestedBackend: 'auto' | 'webgpu' | 'wasm') => {
		const worker = makeWorker();
		activeWorker = worker;
		try {
			await request(worker, 'init', { source: options.source, backend: requestedBackend }, 'ready', options.onProgress);
			const mask = new Uint8Array(options.mask);
			const result = await request(worker, 'generate', { prompt: options.prompt, negativePrompt: options.negativePrompt || '', seed: options.seed, steps: options.steps, guidance: options.guidance, avoidKeepouts: options.avoidKeepouts, mask }, 'result', options.onProgress);
			if (!result.rgba) throw new Error('本地模型没有返回图像');
			const rgba = new Uint8ClampedArray(result.rgba);
			return { rawDataUrl: rgbaToDataUrl(rgba, 512, 512), rgba, seed: result.seed || options.seed, steps: result.steps || options.steps, backend: result.backend || requestedBackend, unetKernelLayout: result.unetKernelLayout || 'unknown', vaeBackend: result.vaeBackend || 'wasm', vaeDecodeMode: result.vaeDecodeMode || 'declared', imageLayout: result.imageLayout || 'unknown', declaredImageLayout: result.declaredImageLayout || 'unknown', scheduler: result.scheduler || 'unknown', conditioningDelta: result.conditioningDelta ?? 0, differingTokenCount: result.differingTokenCount ?? 0, latentSafeRatio: result.latentSafeRatio ?? 1, constraintMode: result.constraintMode || 'unknown' };
		}
		finally {
			worker.terminate();
			if (activeWorker === worker) activeWorker = undefined;
		}
	};
	try {
		return await attempt(options.backend);
	}
	catch (error) {
		if (options.backend !== 'auto' || (error as Error).name === 'AbortError') throw error;
		options.onProgress?.({ phase: 'fallback', message: 'WebGPU 失败，正在用 WASM/CPU 重建 Worker（默认 8 步，可能需要数分钟）…' });
		return attempt('wasm');
	}
}

export function cancelLocal(): void {
	if (activeWorker) {
		activeReject?.(new DOMException('已取消', 'AbortError'));
		activeReject = undefined;
		activeWorker.terminate();
		activeWorker = undefined;
	}
}

export function processLocalRaster(raw: Uint8ClampedArray, mask: Uint8Array, options: Parameters<typeof processRgba>[2]): string {
	return rgbaToDataUrl(processRgba(raw, mask, options), 512, 512);
}

export function rgbaToDataUrl(rgba: Uint8ClampedArray, width: number, height: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = width; canvas.height = height;
	canvas.getContext('2d', { willReadFrequently: false })?.putImageData(new ImageData(rgba, width, height), 0, 0);
	return canvas.toDataURL('image/png');
}

function importedCacheRequest(modelId: string, path: string): Request {
	return new Request(`${location.origin}${CACHE_ROOT}/${modelId}/${path}`);
}

function readRegistry(): ImportedModelRecord[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '[]');
		return Array.isArray(parsed) ? parsed : [];
	}
	catch {
		return [];
	}
}

function writeRegistry(records: ImportedModelRecord[]): void {
	localStorage.setItem(REGISTRY_KEY, JSON.stringify(records));
}

async function hashFile(file: File, onChunk?: (loaded: number) => void): Promise<string> {
	const hash = await createSHA256();
	const reader = file.stream().getReader();
	let loaded = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		hash.update(result.value);
		loaded += result.value.byteLength;
		onChunk?.(loaded);
	}
	return hash.digest();
}

export async function importModelFolder(input: FileList | File[], onProgress?: (progress: LocalProgress) => void): Promise<ImportedModelRecord> {
	const files = Array.from(input);
	if (files.length === 0) throw new Error('没有选择模型文件');
	const relative = files.map(file => file.webkitRelativePath || file.name);
	const paths = stripCommonRoot(relative);
	validateModelPaths(paths);
	const pipeline = pipelineFromIndex(JSON.parse(await files[paths.indexOf('model_index.json')].text()));
	if (pipeline === 'inpainting' && !paths.includes('vae_encoder/model.onnx')) throw new Error('Inpainting 模型目录缺少 VAE encoder');
	const total = files.reduce((sum, file) => sum + file.size, 0);
	const estimate = await navigator.storage?.estimate?.();
	if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < total * 1.1) throw new Error('浏览器缓存空间不足');
	const id = crypto.randomUUID();
	const cache = await caches.open(CACHE_NAME);
	const records: ImportedModelRecord['files'] = [];
	try {
		for (let index = 0; index < files.length; index++) {
			const file = files[index]; const path = paths[index];
			const sha256 = await hashFile(file, loaded => onProgress?.({ phase: 'import', file: path, loaded, total: file.size }));
			await cache.put(importedCacheRequest(id, path), new Response(file, { headers: { 'content-length': String(file.size), 'x-sha256': sha256 } }));
			records.push({ path, size: file.size, sha256 });
		}
		const manifest: LocalModelManifest = { schemaVersion: 1, id, displayName: relative[0].split('/')[0], repository: 'local/imported', revision: id, license: '本地模型许可证', resolution: 512, dtype: 'fp32', pipeline, files: records };
		await cache.put(importedCacheRequest(id, '__manifest.json'), new Response(JSON.stringify(manifest)));
		const worker = makeWorker();
		activeWorker = worker;
		try {
			await request(worker, 'init', { source: { type: 'imported', modelId: id }, backend: 'auto', validateSession: true }, 'ready', onProgress);
		}
		finally {
			worker.terminate();
			if (activeWorker === worker) activeWorker = undefined;
		}
		const rootName = relative[0].replaceAll('\\', '/').split('/')[0] || `Imported ${id.slice(0, 8)}`;
		const record = { id, name: rootName, size: total, fileCount: files.length, files: records, importedAt: Date.now(), manifest };
		writeRegistry([...readRegistry().filter(item => item.id !== id), record]);
		return record;
	}
	catch (error) {
		await Promise.all([...paths, '__manifest.json'].map(path => cache.delete(importedCacheRequest(id, path))));
		throw error;
	}
}

export function listImportedModels(): ImportedModelRecord[] {
	return readRegistry();
}

export async function deleteImportedModel(id: string): Promise<void> {
	const record = readRegistry().find(item => item.id === id);
	if (record) {
		const cache = await caches.open(CACHE_NAME);
		await Promise.all(record.files.map(file => cache.delete(importedCacheRequest(id, file.path))));
		await cache.delete(importedCacheRequest(id, '__manifest.json'));
	}
	writeRegistry(readRegistry().filter(item => item.id !== id));
}

export async function defaultModelStatus(manifest = DEFAULT_MODEL_MANIFEST): Promise<{ cached: number; total: number; complete: boolean }> {
	const cache = await caches.open(CACHE_NAME);
	let cached = 0;
	for (const file of manifest.files) {
		const response = await cache.match(new Request(`${location.origin}${CACHE_ROOT}/${manifest.id}/${file.path}`));
		if (response && Number(response.headers.get('content-length')) === file.size && response.headers.get('x-sha256') === file.sha256) cached += file.size;
	}
	return { cached, total: totalModelBytes(manifest), complete: cached === totalModelBytes(manifest) };
}

export async function saveArtworkImages(id: string, rawDataUrl: string, processedDataUrl: string): Promise<void> {
	const cache = await caches.open(ARTWORK_CACHE_NAME);
	await Promise.all([
		cache.put(new Request(`${location.origin}/__easyeda_color_artworks__/${id}/raw.png`), await fetch(rawDataUrl)),
		cache.put(new Request(`${location.origin}/__easyeda_color_artworks__/${id}/processed.png`), await fetch(processedDataUrl)),
	]);
}

export async function deleteArtworkImages(id: string): Promise<void> {
	if (!id) return;
	const cache = await caches.open(ARTWORK_CACHE_NAME);
	await Promise.all(['raw.png', 'processed.png'].map(name => cache.delete(new Request(`${location.origin}/__easyeda_color_artworks__/${id}/${name}`))));
}

export { DEFAULT_MODEL_MANIFEST, totalModelBytes, isInpainting };
