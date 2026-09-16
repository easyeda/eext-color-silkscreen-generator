import { AutoTokenizer, env } from '@huggingface/transformers';
import { createSHA256 } from 'hash-wasm';
import * as ort from 'onnxruntime-web/all';
import type { LocalModelManifest } from './local-core';
import { isInpainting } from './model-sources';
import { createClipTokenizerJson, createGenerationLatents, createPndmSchedule, createTimestepTensorInput, decodeVaeTensor, DEFAULT_MODEL_MANIFEST, extractVaeEncoderLatents, mixClassifierFreeGuidance, packInpaintingInput, prepareInpaintingCondition, pndmStep, validateManifest } from './local-core';

declare const __ORT_JSEP_MJS_SOURCE__: string;
declare const __ORT_JSEP_WASM_BASE64__: string;

type SourceConfig = { type: 'remote'; mirror: string; manifest?: LocalModelManifest } | { type: 'imported'; modelId: string };
type WorkerRequest = { type: string; payload?: Record<string, any> };

const CACHE_NAME = 'easyeda-color-models-v1';
const CACHE_ROOT = '/__easyeda_color_models__';
let source: SourceConfig = { type: 'remote', mirror: 'https://huggingface.co' };
let backend: 'webgpu' | 'wasm' = 'wasm';
let cancelled = false;
let tokenizer: any;
let unetSession: ort.InferenceSession | undefined;
let vaeSession: ort.InferenceSession | undefined;
let syntheticTokenizerResponse: Promise<Response> | undefined;
let ortModuleUrl: string | undefined;
let ortWasmUrl: string | undefined;
let currentPhase = '初始化';
let modelManifest = DEFAULT_MODEL_MANIFEST;

async function selectSource(value: SourceConfig): Promise<void> {
	source = value;
	if (value.type === 'remote') modelManifest = validateManifest(value.manifest || DEFAULT_MODEL_MANIFEST);
	else {
		try { modelManifest = validateManifest(await (await cachedResponse('__manifest.json')).json()); }
		catch { throw new Error('旧导入模型缺少清单，请重新导入模型目录'); }
	}
}

function base64Bytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function setupOrtRuntimeAssets(): void {
	ortModuleUrl ??= URL.createObjectURL(new Blob([__ORT_JSEP_MJS_SOURCE__], { type: 'text/javascript' }));
	ortWasmUrl ??= URL.createObjectURL(new Blob([base64Bytes(__ORT_JSEP_WASM_BASE64__)], { type: 'application/wasm' }));
	ort.env.wasm.wasmPaths = { mjs: ortModuleUrl, wasm: ortWasmUrl };
}

function post(type: string, payload: Record<string, any> = {}, transfer: Transferable[] = []): void {
	globalThis.postMessage({ type, ...payload }, { transfer });
}

function cacheRequest(path: string): Request {
	const modelId = source.type === 'imported' ? source.modelId : modelManifest.id;
	return new Request(`${location.origin}${CACHE_ROOT}/${modelId}/${path}`);
}

function remoteUrl(path: string): string {
	if (source.type !== 'remote') throw new Error('导入模型没有远程 URL');
	const root = source.mirror.replace(/\/+$/, '');
	return modelManifest.baseUrl ? `${modelManifest.baseUrl.replace(/\/+$/, '')}/${path}` : `${root}/${modelManifest.repository}/resolve/${modelManifest.revision}/${path}`;
}

async function cachedResponse(path: string): Promise<Response> {
	const cache = await caches.open(CACHE_NAME);
	const response = await cache.match(cacheRequest(path));
	if (!response) throw new Error(`模型文件尚未缓存: ${path}`);
	return response;
}

async function downloadFile(file: { path: string; size: number; sha256: string }, index: number, totalFiles: number): Promise<void> {
	const cache = await caches.open(CACHE_NAME);
	const request = cacheRequest(file.path);
	const existing = await cache.match(request);
	if (existing && Number(existing.headers.get('content-length')) === file.size && existing.headers.get('x-sha256') === file.sha256) {
		post('progress', { phase: 'download', file: file.path, index, totalFiles, loaded: file.size, total: file.size, cached: true });
		return;
	}
	const response = await fetch(remoteUrl(file.path), { cache: 'no-store' });
	if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${file.path}`);
	const [cacheStream, hashStream] = response.body.tee();
	const headers = new Headers(response.headers);
	headers.set('content-length', String(file.size));
	headers.set('x-sha256', file.sha256);
	const putPromise = cache.put(request, new Response(cacheStream, { status: 200, headers }));
	const hasher = await createSHA256();
	const reader = hashStream.getReader();
	let loaded = 0;
	const started = performance.now();
	while (true) {
		if (cancelled) throw new DOMException('已取消', 'AbortError');
		const result = await reader.read();
		if (result.done) break;
		hasher.update(result.value);
		loaded += result.value.byteLength;
		post('progress', { phase: 'download', file: file.path, index, totalFiles, loaded, total: file.size, speed: loaded / Math.max(0.001, (performance.now() - started) / 1000), cached: false });
	}
	await putPromise;
	const digest = hasher.digest();
	if (loaded !== file.size || digest !== file.sha256) {
		await cache.delete(request);
		throw new Error(`模型校验失败: ${file.path}`);
	}
}

async function ensureDownloaded(): Promise<void> {
	if (source.type === 'imported') return;
	const estimate = await navigator.storage?.estimate?.();
	const cache = await caches.open(CACHE_NAME);
	let missingBytes = 0;
	for (const file of modelManifest.files) {
		const response = await cache.match(cacheRequest(file.path));
		if (!response || Number(response.headers.get('content-length')) !== file.size || response.headers.get('x-sha256') !== file.sha256) missingBytes += file.size;
	}
	const required = Math.ceil(missingBytes * 1.25);
	if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < required) {
		throw new Error(`缓存空间不足，需要至少 ${(required / 1024 ** 3).toFixed(1)} GB 可用空间`);
	}
	const remainingBytes = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : undefined;
	post('progress', { phase: 'storage', message: remainingBytes === undefined ? '无法读取浏览器缓存余量' : `缓存可用空间 ${(remainingBytes / 1024 ** 3).toFixed(1)} GB`, remainingBytes });
	for (let index = 0; index < modelManifest.files.length; index++) {
		await downloadFile(modelManifest.files[index], index + 1, modelManifest.files.length);
	}
}

async function modelUrl(path: string): Promise<{ url: string; release: () => void }> {
	const blob = await (await cachedResponse(path)).blob();
	const url = URL.createObjectURL(blob);
	return { url, release: () => URL.revokeObjectURL(url) };
}

function sessionOptions(extra: ort.InferenceSession.SessionOptions = {}): ort.InferenceSession.SessionOptions {
	const executionProviders: ort.InferenceSession.ExecutionProviderConfig[] = backend === 'webgpu' ? [{ name: 'webgpu', preferredLayout: 'NCHW' }, 'wasm'] : ['wasm'];
	return { executionProviders, graphOptimizationLevel: 'all', enableMemPattern: false, enableCpuMemArena: false, ...extra };
}

async function createSession(path: string, extra: ort.InferenceSession.SessionOptions = {}): Promise<ort.InferenceSession> {
	const model = await modelUrl(path);
	try {
		return await ort.InferenceSession.create(model.url, sessionOptions(extra));
	}
	finally {
		model.release();
	}
}

async function createUnet(): Promise<ort.InferenceSession> {
	const model = await modelUrl('unet/model.onnx');
	const weightPath = modelManifest.files.find(file => ['unet/model.onnx_data', 'unet/weights.pb'].includes(file.path))!.path;
	const weights = await modelUrl(weightPath);
	const inpainting = isInpainting(modelManifest);
	try {
		const session = await ort.InferenceSession.create(model.url, sessionOptions({
			freeDimensionOverrides: inpainting ? { batch: 2, channels: 9, height: 64, width: 64, sequence: 77 } : { batch_size: 2, num_channels: 4, height: 64, width: 64, sequence_length: 77 },
			externalData: [{ path: weightPath.split('/').at(-1)!, data: weights.url }],
		}));
		const input = session.inputMetadata.find(item => item.name === 'sample');
		if (!input?.isTensor || input.type !== 'float32' || (typeof input.shape[1] === 'number' && input.shape[1] !== (inpainting ? 9 : 4))) {
			await session.release();
			throw new Error('UNet 输入必须为 FP32，通道数须与模型类型匹配（Inpainting 9 / 普通 4）');
		}
		return session;
	}
	finally {
		model.release();
		weights.release();
	}
}

async function setupTokenizer(): Promise<void> {
	if (tokenizer) return;
	currentPhase = '加载 tokenizer';
	(env as any).allowRemoteModels = false;
	(env as any).allowLocalModels = true;
	(env as any).useBrowserCache = false;
	(env as any).useCustomCache = true;
	(env as any).customCache = {
		match: async (request: RequestInfo | URL) => {
			const raw = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
			const clean = decodeURIComponent(raw).split('?')[0];
			const filename = clean.split('/').pop();
			if (filename === 'tokenizer.json') {
				syntheticTokenizerResponse ??= Promise.all([
					cachedResponse('tokenizer/vocab.json').then(response => response.json()),
					cachedResponse('tokenizer/merges.txt').then(response => response.text()),
				]).then(([vocab, merges]) => {
					const body = JSON.stringify(createClipTokenizerJson(vocab as Record<string, number>, merges));
					return new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } });
				});
				return (await syntheticTokenizerResponse).clone();
			}
			const direct = modelManifest.files.map(item => item.path).find(item => clean.endsWith(`/${item}`));
			const tokenizerPath = filename ? `tokenizer/${filename}` : '';
			const path = direct || modelManifest.files.some(item => item.path === tokenizerPath) ? direct || tokenizerPath : undefined;
			return path ? cachedResponse(path).catch(() => undefined) : undefined;
		},
		put: async () => { throw new Error('模型缓存只读'); },
	};
	tokenizer = await AutoTokenizer.from_pretrained('imported/sd15', { local_files_only: true });
}

async function encodePrompt(prompt: string, negativePrompt: string): Promise<{ embeddings: ort.Tensor; conditioningDelta: number; differingTokenCount: number }> {
	await setupTokenizer();
	currentPhase = '加载文本编码器';
	post('progress', { phase: 'load', message: '加载文本编码器…' });
	const session = await createSession('text_encoder/model.onnx', { freeDimensionOverrides: { batch_size: 2, sequence_length: 77 } });
	try {
		const encode = async (text: string): Promise<number[]> => {
			const result = await tokenizer(text, { padding: 'max_length', max_length: 77, truncation: true, return_tensor: false });
			return Array.from(result.input_ids.data ?? result.input_ids).slice(0, 77).map(Number);
		};
		const [negative, positive] = await Promise.all([encode(negativePrompt), encode(prompt)]);
		const differingTokenCount = positive.reduce((total, token, index) => total + Number(token !== negative[index]), 0);
		if (differingTokenCount < 2) throw new Error('正向提示词没有产生有效 token，请改用更具体的英文描述');
		const tokenInput = session.inputMetadata.find(item => item.name === 'input_ids');
		if (!tokenInput?.isTensor || !['int32', 'int64'].includes(tokenInput.type)) throw new Error('文本编码器 input_ids 类型不支持');
		const ids = tokenInput.type === 'int64'
			? new ort.Tensor('int64', BigInt64Array.from([...negative, ...positive], BigInt), [2, 77])
			: new ort.Tensor('int32', Int32Array.from([...negative, ...positive]), [2, 77]);
		const outputs = await session.run({ input_ids: ids });
		ids.dispose();
		const embeddings = outputs.last_hidden_state ?? outputs[session.outputNames[0]];
		if (embeddings.type !== 'float32' || embeddings.dims[0] !== 2) throw new Error(`文本编码器输出无效: ${embeddings.type} ${embeddings.dims.join('×')}`);
		const values = embeddings.data as Float32Array;
		const half = values.length / 2;
		let totalDelta = 0;
		for (let index = 0; index < half; index++) totalDelta += Math.abs(values[index + half] - values[index]);
		const conditioningDelta = totalDelta / Math.max(1, half);
		if (!Number.isFinite(conditioningDelta) || conditioningDelta < 1e-5) throw new Error('正向与负向文本嵌入相同，提示词编码失败');
		return { embeddings, conditioningDelta, differingTokenCount };
	}
	finally {
		await session.release();
	}
}

function guidedNoise(output: ort.Tensor, guidance: number, spatialMask?: Uint8Array): Float32Array {
	if (output.type !== 'float32' || output.dims.length !== 4 || output.dims[0] !== 2 || output.dims[1] !== 4) throw new Error(`UNet 输出不符合 [2,4,H,W] float32: ${output.type} ${output.dims.join('×')}`);
	const data = output.data as Float32Array;
	const half = data.length / 2;
	return mixClassifierFreeGuidance(data.subarray(0,half),data.subarray(half),guidance,spatialMask);
}

async function encodeMaskedImage(image: Float32Array): Promise<Float32Array> {
	currentPhase = 'VAE 编码 BBOX 背景条件';
	post('progress', { phase: 'load', message: '编码器件框背景与开放区域…' });
	const session = await createSession('vae_encoder/model.onnx', { executionProviders: ['wasm'] });
	const input = new ort.Tensor('float32', image, [1, 3, 512, 512]);
	try {
		const outputs = await session.run({ sample: input });
		try {
			const output = outputs.latent_sample ?? outputs.latent_parameters ?? outputs[session.outputNames[0]];
			if (output.type !== 'float32') throw new Error(`VAE encoder 必须输出 FP32，实际为 ${output.type}`);
			const latents = extractVaeEncoderLatents(output.data as Float32Array, output.dims);
			return Float32Array.from(latents, value => value * 0.18215);
		}
		finally { Object.values(outputs).forEach(value => value.dispose()); }
	}
	finally { input.dispose(); await session.release(); }
}

async function generate(payload: Record<string, any>): Promise<void> {
	const scheduler = await (await cachedResponse('scheduler/scheduler_config.json')).json();
	if (scheduler._class_name !== 'PNDMScheduler' || scheduler.prediction_type !== 'epsilon' || scheduler.beta_schedule !== 'scaled_linear' || scheduler.beta_start !== 0.00085 || scheduler.beta_end !== 0.012 || scheduler.num_train_timesteps !== 1000 || scheduler.skip_prk_steps !== true || scheduler.steps_offset !== 1) throw new Error('模型 scheduler 与当前 Inpainting PNDM 配置不兼容');
	const mask = new Uint8Array(payload.mask);
	const condition = prepareInpaintingCondition(mask);
	const latentMask = condition.mask;
	const latentSafeRatio = latentMask.reduce((total, value) => total + Number(value !== 0), 0) / latentMask.length;
	const constrainLatents = payload.avoidKeepouts === true;
	const conditioning = await encodePrompt(String(payload.prompt), String(payload.negativePrompt || ''));
	const embeddings = conditioning.embeddings;
	const inpainting = isInpainting(modelManifest);
	const maskedImageLatents = inpainting ? await encodeMaskedImage(condition.image) : undefined;
	const steps = backend === 'wasm' ? Math.min(8, Number(payload.steps) || 8) : Math.min(30, Number(payload.steps) || 10);
	const schedule = createPndmSchedule(steps);
	const schedulerState = { counter: 0, ets: [] as Float32Array[] };
	let latents = createGenerationLatents(Number(payload.seed) >>> 0);
	post('progress', { phase: 'load', message: `加载 UNet（${backend}）…` });
	currentPhase = `加载 ${inpainting ? 9 : 4} 通道 UNet 与外部权重`;
	unetSession ??= await createUnet();
	const timestepMetadata = unetSession.inputMetadata.find(item => item.name === 'timestep');
	if (!timestepMetadata?.isTensor || timestepMetadata.type !== 'float32') throw new Error('UNet timestep 输入必须为 FP32 tensor');
	for (let index = 0; index < schedule.timesteps.length; index++) {
		if (cancelled) throw new DOMException('已取消', 'AbortError');
		const timestep = schedule.timesteps[index];
		const batched = maskedImageLatents ? packInpaintingInput(latents, latentMask, maskedImageLatents) : new Float32Array([...latents, ...latents]);
		currentPhase = `UNet 去噪 ${index + 1}/${schedule.timesteps.length}`;
		const timestepInput = createTimestepTensorInput(timestep, timestepMetadata.shape, 2);
		const inputs = {
			sample: new ort.Tensor('float32', batched, [2, inpainting ? 9 : 4, 64, 64]),
			timestep: new ort.Tensor('float32', timestepInput.data, timestepInput.dims),
			encoder_hidden_states: embeddings,
		};
		const outputs = await unetSession.run(inputs);
		inputs.sample.dispose(); inputs.timestep.dispose();
		const noise = guidedNoise(outputs.out_sample ?? outputs[unetSession.outputNames[0]], Number(payload.guidance) || 7);
		Object.values(outputs).forEach(value => value.dispose());
		latents = pndmStep(latents, noise, timestep, schedule, schedulerState);
		post('step', { current: index + 1, total: schedule.timesteps.length });
	}
	embeddings.dispose();
	if (backend === 'wasm') { await unetSession.release(); unetSession = undefined; }
	for (let index = 0; index < latents.length; index++) latents[index] /= 0.18215;
	post('progress', { phase: 'load', message: '加载 VAE 解码器…' });
	currentPhase = '加载 VAE 解码器';
	// Keep the expensive denoising loop on WebGPU, but decode with WASM. On the
	// EasyEDA Chromium/WebGPU stack the VAE ConvTranspose path can return a
	// partially corrupted image (usually vertical stripes in the upper bands)
	// even though its tensor metadata still says NCHW. The 198 MB VAE is small
	// enough for WASM and its output order is deterministic.
	const vaeBackend = 'wasm';
	vaeSession ??= await createSession('vae_decoder/model.onnx', {
		executionProviders: ['wasm'],
		freeDimensionOverrides: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 },
	});
	const decoded = await vaeSession.run({ latent_sample: new ort.Tensor('float32', latents, [1, 4, 64, 64]) });
	const output = decoded.sample ?? decoded[vaeSession.outputNames[0]];
	const image = decodeVaeTensor(output.data as Float32Array, output.dims, 'declared');
	if (image.width !== 512 || image.height !== 512) throw new Error(`仅支持 512×512 VAE 输出，实际为 ${image.width}×${image.height}`);
	const rgba = image.rgba;
	if (backend === 'wasm') { await vaeSession.release(); vaeSession = undefined; }
	post('result', { rgba: rgba.buffer, seed: Number(payload.seed) >>> 0, steps, backend, unetKernelLayout: 'nchw', vaeBackend, vaeDecodeMode: 'declared', imageLayout: image.layout, declaredImageLayout: image.declaredLayout, scheduler: 'pndm', conditioningDelta: conditioning.conditioningDelta, differingTokenCount: conditioning.differingTokenCount, latentSafeRatio, constraintMode: inpainting ? (constrainLatents ? 'inpainting-9ch-bbox' : 'inpainting-board-only') : 'disabled' }, [rgba.buffer]);
}

async function release(): Promise<void> {
	await unetSession?.release(); await vaeSession?.release();
	unetSession = undefined; vaeSession = undefined; tokenizer = undefined; syntheticTokenizerResponse = undefined;
	if (ortModuleUrl) URL.revokeObjectURL(ortModuleUrl);
	if (ortWasmUrl) URL.revokeObjectURL(ortWasmUrl);
	ortModuleUrl = undefined; ortWasmUrl = undefined;
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const { type, payload = {} } = event.data;
	try {
		if (type === 'cancel') { cancelled = true; return; }
		if (type === 'release') { await release(); post('ready', { released: true }); return; }
		cancelled = false;
		if (type === 'download') {
			await selectSource(payload.source as SourceConfig);
			await ensureDownloaded();
			post('ready', { downloaded: true });
			return;
		}
		if (type === 'init') {
			currentPhase = '初始化 ONNX Runtime';
			await selectSource(payload.source as SourceConfig);
			backend = payload.backend === 'wasm' || !(globalThis.navigator as any).gpu ? 'wasm' : 'webgpu';
			ort.env.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
			ort.env.wasm.simd = true;
			setupOrtRuntimeAssets();
			await setupTokenizer();
			if (payload.validateSession) {
				post('progress', { phase: 'validate', message: '初始化文本编码器 session…' });
				const validationSession = await createSession('text_encoder/model.onnx', { freeDimensionOverrides: { batch_size: 1, sequence_length: 77 } });
				await validationSession.release();
				const validationUnet = await createUnet();
				await validationUnet.release();
				if (isInpainting(modelManifest)) await encodeMaskedImage(prepareInpaintingCondition(new Uint8Array(512 * 512).fill(255)).image);
			}
			post('ready', { backend });
			return;
		}
		if (type === 'generate') await generate(payload);
	}
	catch (error) {
		const value = error as Error;
		post('error', { message: `[${currentPhase}] ${value.name || 'Error'}: ${value.message || String(value)}`, name: value.name || 'Error' });
	}
};
