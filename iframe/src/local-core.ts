export type LocalBackend = 'auto' | 'webgpu' | 'wasm';

export interface ModelFile {
	path: string;
	size: number;
	sha256: string;
}

export interface LocalModelManifest {
	schemaVersion: 1;
	id: string;
	displayName: string;
	repository: string;
	revision: string;
	license: string;
	resolution: 512;
	dtype: 'fp32';
	baseUrl?: string;
	pipeline?: 'inpainting' | 'text-to-image';
	files: ModelFile[];
}

export interface RasterProcessingOptions {
	backgroundThreshold: number;
	paletteSize: number;
	saturation: number;
	opacity: number;
}

export type ImageTensorLayout = 'nchw' | 'nhwc';

export interface DecodedTensorImage {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
	layout: ImageTensorLayout;
	declaredLayout: ImageTensorLayout;
}

export interface CanonicalTensor {
	data: Float32Array;
	layout: ImageTensorLayout;
	declaredLayout: ImageTensorLayout;
}

const MODEL_FILES: ModelFile[] = [
	{
		"path": "model_index.json",
		"size": 631,
		"sha256": "96dca1dd90459a85a8365a8794f89e5a483c6784f43a9bb03aee9df73fe5f452"
	},
	{
		"path": "scheduler/scheduler_config.json",
		"size": 389,
		"sha256": "17e070fc14e1dd0f8c046a52294de4ed9192c549ed246c9d56dfdb6c20a57f4f"
	},
	{
		"path": "text_encoder/model.onnx",
		"size": 492464677,
		"sha256": "f1e684d5b0db86122de2f592301bfdc63c416ee5b7782c1ceaba09f06c4f28a7"
	},
	{
		"path": "tokenizer/merges.txt",
		"size": 573514,
		"sha256": "0bc7695944744789d6fd6d0ab754bcbbb9e36f1c182df0a006d619ce70a1e052"
	},
	{
		"path": "tokenizer/special_tokens_map.json",
		"size": 496,
		"sha256": "c8227988aadac941e93b5ffef08b4add8ccbdb26404a62b3e41f61eef119b252"
	},
	{
		"path": "tokenizer/tokenizer_config.json",
		"size": 766,
		"sha256": "3ab3602fd7f809820585cdad08484f517054420416fcefac189433c3cceaa324"
	},
	{
		"path": "tokenizer/vocab.json",
		"size": 1109372,
		"sha256": "fd67774a869730a6b27bf53d3e434e72054f2a825873c7af3bece183bb1f791e"
	},
	{
		"path": "unet/model.onnx",
		"size": 1086463,
		"sha256": "3087104da1eb1b19c8fba6f123d570e3f1d652de606aa53040afa95ea1b1e484"
	},
	{
		"path": "unet/model.onnx_data",
		"size": 3438157696,
		"sha256": "de67164d76737fee680b8cfaee1f068cc544b277fbb641b485d8063aed5b2f3c"
	},
	{
		"path": "vae_decoder/model.onnx",
		"size": 198078154,
		"sha256": "b1e0fb0085ca2b227edcaeda371ab9eb4d1892d07b7981464525811fae42fb1e"
	},
	{
		"path": "vae_encoder/model.onnx",
		"size": 136756676,
		"sha256": "faab243c202659914b9b16ba67468e0c9c7c1ef848e4e2221c97ecd7a7350efe"
	}
];

export const DEFAULT_MODEL_MANIFEST: LocalModelManifest = {
	schemaVersion: 1,
	id: 'sd15-inpaint-af6eef7',
	pipeline: 'inpainting',
	displayName: 'Stable Diffusion 1.5 Inpainting ONNX FP32',
	repository: 'JasonYANG170/sd15-inpainting-onnx-fp32',
	revision: 'af6eef7c7c40a36f26b3c6ef99b0463ae006ae60',
	license: 'creativeml-openrail-m',
	resolution: 512,
	dtype: 'fp32',
	files: MODEL_FILES,
};

export const REQUIRED_MODEL_PATHS = MODEL_FILES.map(file => file.path);

export function validateManifest(value: unknown): LocalModelManifest {
	const manifest = value as LocalModelManifest;
	if (!manifest || manifest.schemaVersion !== 1 || !manifest.id || !manifest.repository || !manifest.revision) {
		throw new Error('模型 manifest 缺少必需字段');
	}
	if (manifest.resolution !== 512 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
		throw new Error('只支持 512px Diffusers ONNX 模型包');
	}
	for (const file of manifest.files) {
		if (!file.path || !/^[\w./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..') || !Number.isSafeInteger(file.size) || file.size <= 0 || !/^[\da-f]{64}$/i.test(file.sha256)) {
			throw new Error(`模型文件声明无效: ${file.path || '(unknown)'}`);
		}
	}
	if (manifest.dtype !== 'fp32') throw new Error('当前仅支持 FP32 模型');
	return manifest;
}

export function validateModelPaths(paths: string[]): void {
	const normalized = new Set(paths.map(path => path.replaceAll('\\', '/').replace(/^\/+/, '')));
	const required = REQUIRED_MODEL_PATHS.filter(path => !['vae_encoder/model.onnx', 'unet/model.onnx_data'].includes(path));
	const missing = required.filter(path => !normalized.has(path));
	if (!normalized.has('unet/model.onnx_data') && !normalized.has('unet/weights.pb')) missing.push('unet/model.onnx_data 或 unet/weights.pb');
	if (missing.length > 0) {
		throw new Error(`模型目录不完整，缺少: ${missing.join(', ')}`);
	}
}

export function stripCommonRoot(paths: string[]): string[] {
	const normalized = paths.map(path => path.replaceAll('\\', '/').replace(/^\/+/, ''));
	const roots = normalized.map(path => path.split('/')[0]);
	const hasRoot = roots.length > 0 && roots.every(root => root === roots[0]) && normalized.every(path => path.includes('/'));
	return hasRoot ? normalized.map(path => path.split('/').slice(1).join('/')) : normalized;
}

export function totalModelBytes(manifest = DEFAULT_MODEL_MANIFEST): number {
	return manifest.files.reduce((total, file) => total + file.size, 0);
}

export function createClipTokenizerJson(vocab: Record<string, number>, mergesText: string): Record<string, unknown> {
	const merges = mergesText.replaceAll('\r', '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
	if (Object.keys(vocab).length < 49000 || merges.length < 48000) throw new Error('CLIP tokenizer vocab/merges 不完整');
	return {
		version: '1.0',
		truncation: null,
		padding: null,
		added_tokens: [
			{ id: 49406, content: '<|startoftext|>', single_word: false, lstrip: false, rstrip: false, normalized: true, special: true },
			{ id: 49407, content: '<|endoftext|>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
		],
		normalizer: null,
		pre_tokenizer: {
			type: 'Sequence',
			pretokenizers: [
				{ type: 'Split', pattern: { Regex: "'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+" }, behavior: 'Removed', invert: true },
				{ type: 'ByteLevel', add_prefix_space: false, trim_offsets: true },
			],
		},
		post_processor: { type: 'RobertaProcessing', sep: ['<|endoftext|>', 49407], cls: ['<|startoftext|>', 49406], trim_offsets: false, add_prefix_space: false },
		decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true },
		model: { type: 'BPE', dropout: null, unk_token: '<|endoftext|>', continuing_subword_prefix: '', end_of_word_suffix: '</w>', fuse_unk: false, vocab, merges },
	};
}

export function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6D2B79F5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

export function createLatents(seed: number, latentMask: Uint8Array, batch = 1): Float32Array {
	if (latentMask.length !== 64 * 64) throw new Error('latent mask 必须为 64×64');
	const random = createSeededRandom(seed);
	const output = new Float32Array(batch * 4 * 64 * 64);
	let spare: number | undefined;
	for (let index = 0; index < output.length; index++) {
		let gaussian: number;
		if (spare !== undefined) {
			gaussian = spare;
			spare = undefined;
		}
		else {
			const u = Math.max(Number.EPSILON, random());
			const v = random();
			const radius = Math.sqrt(-2 * Math.log(u));
			gaussian = radius * Math.cos(2 * Math.PI * v);
			spare = radius * Math.sin(2 * Math.PI * v);
		}
		output[index] = latentMask[index % 4096] ? gaussian : 0;
	}
	return output;
}

export function createGenerationLatents(seed: number): Float32Array {
	return createLatents(seed, new Uint8Array(64 * 64).fill(1));
}

export function downsampleMask(mask: Uint8Array, size = 512): Uint8Array {
	if (mask.length !== size * size || size % 64 !== 0) throw new Error('制造蒙版尺寸无效');
	const block = size / 64;
	const result = new Uint8Array(4096);
	for (let y = 0; y < 64; y++) {
		for (let x = 0; x < 64; x++) {
			let safe = 1;
			for (let by = 0; by < block && safe; by++) {
				for (let bx = 0; bx < block; bx++) {
					if (!mask[(y * block + by) * size + x * block + bx]) {
						safe = 0;
						break;
					}
				}
			}
			result[y * 64 + x] = safe;
		}
	}
	return result;
}

export function applyLatentMask(latents: Float32Array, latentMask: Uint8Array): void {
	for (let index = 0; index < latents.length; index++) {
		if (!latentMask[index % 4096]) latents[index] = 0;
	}
}

export function mixClassifierFreeGuidance(unconditional: Float32Array, conditional: Float32Array, guidance: number, spatialMask?: Uint8Array): Float32Array {
	if (unconditional.length !== conditional.length) throw new Error('CFG tensor shape mismatch');
	if (spatialMask && spatialMask.length === 0) throw new Error('CFG spatial mask is empty');
	const result = new Float32Array(unconditional.length);
	for (let index = 0; index < result.length; index++) {
		const localGuidance = !spatialMask || spatialMask[index % spatialMask.length] ? guidance : 0;
		result[index] = unconditional[index] + localGuidance * (conditional[index] - unconditional[index]);
	}
	return result;
}

// White = repaint; black = preserve a black RGB background. Masked (unknown)
// image pixels are zero in normalized RGB, whereas known black pixels are -1.
export function prepareInpaintingCondition(mask: Uint8Array): { mask: Float32Array; image: Float32Array } {
	if (mask.length !== 512 * 512) throw new Error('Inpainting mask 必须为 512×512');
	const image = new Float32Array(3 * mask.length);
	for (let c = 0; c < 3; c++) for (let p = 0; p < mask.length; p++) image[c * mask.length + p] = mask[p] >= 128 ? 0 : -1;
	// Match Diffusers' nearest-neighbor resize; do not expand dense BBOXs to
	// every overlapping 8x8 block, which can erase most of the open space.
	const latentMask = new Float32Array(4096);
	for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) latentMask[y * 64 + x] = mask[(y * 8 + 4) * 512 + x * 8 + 4] >= 128 ? 1 : 0;
	return { mask: latentMask, image };
}

export function packInpaintingInput(latents: Float32Array, mask: Float32Array, encodedImage: Float32Array): Float32Array {
	if (latents.length !== 16384 || mask.length !== 4096 || encodedImage.length !== 16384) throw new Error('Inpainting 条件尺寸不匹配');
	const sample = new Float32Array(2 * 9 * 4096);
	for (let batch = 0; batch < 2; batch++) {
		const offset = batch * 9 * 4096;
		sample.set(latents, offset);
		sample.set(mask, offset + 4 * 4096);
		sample.set(encodedImage, offset + 5 * 4096);
	}
	return sample;
}

export interface DdimSchedule {
	timesteps: number[];
	alphaCumprod: Float64Array;
}

export interface PndmSchedule {
	timesteps: number[];
	alphaCumprod: Float64Array;
	stepRatio: number;
}

export interface PndmState {
	counter: number;
	ets: Float32Array[];
	currentSample?: Float32Array;
}

export function createDdimSchedule(steps: number): DdimSchedule {
	const count = Math.max(1, Math.min(50, Math.round(steps)));
	const alphaCumprod = new Float64Array(1000);
	let cumulative = 1;
	for (let index = 0; index < 1000; index++) {
		const ratio = index / 999;
		const beta = (Math.sqrt(0.00085) + ratio * (Math.sqrt(0.012) - Math.sqrt(0.00085))) ** 2;
		cumulative *= 1 - beta;
		alphaCumprod[index] = cumulative;
	}
	const stride = Math.floor(1000 / count);
	const timesteps = Array.from({ length: count }, (_, index) => Math.min(999, (count - 1 - index) * stride + 1));
	return { timesteps, alphaCumprod };
}

export function createPndmSchedule(steps: number): PndmSchedule {
	const count = Math.max(2, Math.min(50, Math.round(steps)));
	const alphaCumprod = createDdimSchedule(count).alphaCumprod;
	const stepRatio = Math.floor(1000 / count);
	const ascending = Array.from({ length: count }, (_, index) => index * stepRatio + 1);
	const timesteps = [...ascending.slice(0, -1), ascending.at(-2)!, ascending.at(-1)!].reverse();
	return { timesteps, alphaCumprod, stepRatio };
}

function combinePndmOutputs(outputs: Float32Array[]): Float32Array {
	const result = new Float32Array(outputs[0].length);
	for (let index = 0; index < result.length; index++) {
		if (outputs.length === 1) result[index] = outputs[0][index];
		else if (outputs.length === 2) result[index] = (3 * outputs[1][index] - outputs[0][index]) / 2;
		else if (outputs.length === 3) result[index] = (23 * outputs[2][index] - 16 * outputs[1][index] + 5 * outputs[0][index]) / 12;
		else result[index] = (55 * outputs[3][index] - 59 * outputs[2][index] + 37 * outputs[1][index] - 9 * outputs[0][index]) / 24;
	}
	return result;
}

export function pndmStep(sample: Float32Array, modelOutput: Float32Array, timestep: number, schedule: PndmSchedule, state: PndmState): Float32Array {
	if (sample.length !== modelOutput.length) throw new Error('PNDM tensor shape mismatch');
	let effectiveSample = sample;
	let effectiveTimestep = timestep;
	let previousTimestep = timestep - schedule.stepRatio;
	let output: Float32Array;
	if (state.counter === 1) {
		previousTimestep = timestep;
		effectiveTimestep = timestep + schedule.stepRatio;
		effectiveSample = state.currentSample ?? sample;
		output = new Float32Array(modelOutput.length);
		for (let index = 0; index < output.length; index++) output[index] = (modelOutput[index] + state.ets.at(-1)![index]) / 2;
		state.currentSample = undefined;
	}
	else {
		state.ets = [...state.ets.slice(-3), new Float32Array(modelOutput)];
		if (state.counter === 0) state.currentSample = new Float32Array(sample);
		output = combinePndmOutputs(state.ets);
	}
	const alpha = schedule.alphaCumprod[effectiveTimestep];
	const previousAlpha = previousTimestep >= 0 ? schedule.alphaCumprod[previousTimestep] : schedule.alphaCumprod[0];
	const beta = 1 - alpha;
	const previousBeta = 1 - previousAlpha;
	const denominator = Math.sqrt(alpha * beta) * Math.sqrt(previousAlpha) + alpha * Math.sqrt(previousBeta);
	const result = new Float32Array(sample.length);
	// Diffusers PNDM _get_prev_sample subtracts
	// (alpha_prod_t_prev - alpha_prod_t) * model_output. Reversing this
	// difference adds the predicted noise back at every step and produces the
	// characteristic stripe/static output instead of a denoised image.
	for (let index = 0; index < result.length; index++) result[index] = Math.sqrt(previousAlpha / alpha) * effectiveSample[index] - (previousAlpha - alpha) * output[index] / denominator;
	state.counter++;
	return result;
}

export function createTimestepData(timestep: number): Float32Array {
	return Float32Array.of(Number(timestep));
}

export function createTimestepTensorInput(timestep: number, inputShape: readonly (number | string)[], batchSize = 2): { data: Float32Array; dims: number[] } {
	if (inputShape.length === 0) return { data: createTimestepData(timestep), dims: [] };
	if (inputShape.length !== 1) throw new Error(`UNet timestep 输入维度无效: ${inputShape.join('×')}`);
	const declared = inputShape[0];
	const count = typeof declared === 'number' ? declared : batchSize;
	if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`UNet timestep 批次无效: ${String(declared)}`);
	return { data: new Float32Array(count).fill(Number(timestep)), dims: [count] };
}

function tensorPixels(data: Float32Array, width: number, height: number, layout: ImageTensorLayout): Uint8ClampedArray {
	const pixels = width * height;
	const rgba = new Uint8ClampedArray(pixels * 4);
	for (let pixel = 0; pixel < pixels; pixel++) {
		for (let channel = 0; channel < 3; channel++) {
			const source = layout === 'nchw' ? channel * pixels + pixel : pixel * 3 + channel;
			rgba[pixel * 4 + channel] = Math.round(Math.max(0, Math.min(1, data[source] / 2 + 0.5)) * 255);
		}
		rgba[pixel * 4 + 3] = 255;
	}
	return rgba;
}

function spatialDiscontinuity(rgba: Uint8ClampedArray, width: number, height: number): number {
	let score = 0;
	let comparisons = 0;
	const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 65_536)));
	for (let y = 0; y < height; y += stride) {
		for (let x = 0; x < width; x += stride) {
			const pixel = (y * width + x) * 4;
			for (const adjacent of [x + stride < width ? pixel + stride * 4 : -1, y + stride < height ? pixel + stride * width * 4 : -1]) {
				if (adjacent < 0) continue;
				for (let channel = 0; channel < 3; channel++) score += Math.abs(rgba[pixel + channel] - rgba[adjacent + channel]);
				comparisons += 3;
			}
		}
	}
	return score / Math.max(1, comparisons);
}

function tensorDiscontinuity(data: Float32Array, batch: number, channels: number, width: number, height: number): number {
	let score = 0;
	let comparisons = 0;
	const pixels = width * height;
	for (let item = 0; item < batch; item++) {
		for (let channel = 0; channel < channels; channel++) {
			const offset = (item * channels + channel) * pixels;
			for (let y = 0; y < height; y += 2) {
				for (let x = 0; x < width; x += 2) {
					const index = offset + y * width + x;
					if (x + 2 < width) { score += Math.abs(data[index] - data[index + 2]); comparisons++; }
					if (y + 2 < height) { score += Math.abs(data[index] - data[index + width * 2]); comparisons++; }
				}
			}
		}
	}
	return score / Math.max(1, comparisons);
}

function nhwcToNchw(data: Float32Array, batch: number, channels: number, width: number, height: number): Float32Array {
	const pixels = width * height;
	const result = new Float32Array(data.length);
	for (let item = 0; item < batch; item++) {
		for (let pixel = 0; pixel < pixels; pixel++) {
			for (let channel = 0; channel < channels; channel++) {
				result[(item * channels + channel) * pixels + pixel] = data[(item * pixels + pixel) * channels + channel];
			}
		}
	}
	return result;
}

export function canonicalizeNchwTensor(data: Float32Array, dims: readonly number[], channels: number): CanonicalTensor {
	if (dims.length !== 4 || dims[0] <= 0) throw new Error(`扩散张量维度无效: ${dims.join('×')}`);
	const declaredLayout: ImageTensorLayout = dims[1] === channels ? 'nchw' : dims[3] === channels ? 'nhwc' : (() => { throw new Error(`扩散张量通道数无效: ${dims.join('×')}`); })();
	const batch = dims[0];
	const height = declaredLayout === 'nchw' ? dims[2] : dims[1];
	const width = declaredLayout === 'nchw' ? dims[3] : dims[2];
	if (data.length !== batch * channels * width * height) throw new Error(`扩散张量长度不匹配: ${dims.join('×')} / ${data.length}`);
	if (declaredLayout === 'nhwc') return { data: nhwcToNchw(data, batch, channels, width, height), layout: 'nhwc', declaredLayout };
	const alternate = nhwcToNchw(data, batch, channels, width, height);
	const declaredScore = tensorDiscontinuity(data, batch, channels, width, height);
	const alternateScore = tensorDiscontinuity(alternate, batch, channels, width, height);
	const layout: ImageTensorLayout = alternateScore < declaredScore * 0.82 ? 'nhwc' : 'nchw';
	return { data: layout === 'nhwc' ? alternate : data, layout, declaredLayout };
}

/** Normalize the two VAE encoder contracts used by Diffusers ONNX exports.
 * Older exports expose a sampled [1,4,H,W] latent, while current Optimum
 * exports expose [mean, log-variance] as [1,8,H,W]. For masked-image
 * conditioning the mean is deterministic and avoids consuming extra PRNG
 * state, so identical prompts and seeds remain reproducible. */
export function extractVaeEncoderLatents(data: Float32Array, dims: readonly number[]): Float32Array {
	if (dims.length !== 4 || dims[0] !== 1) throw new Error(`VAE encoder 输出维度无效: ${dims.join('×')}`);
	const channels = dims[1] === 4 || dims[1] === 8 ? dims[1] : dims[3] === 4 || dims[3] === 8 ? dims[3] : 0;
	if (!channels) throw new Error(`VAE encoder 必须输出 4 通道 latent 或 8 通道分布参数，实际为 ${dims.join('×')}`);
	const layout: ImageTensorLayout = dims[1] === channels ? 'nchw' : 'nhwc';
	const height = layout === 'nchw' ? dims[2] : dims[1];
	const width = layout === 'nchw' ? dims[3] : dims[2];
	if (width !== 64 || height !== 64 || data.length !== channels * width * height) {
		throw new Error(`VAE encoder 输出尺寸不匹配，期望 64×64，实际为 ${dims.join('×')} / ${data.length}`);
	}
	const canonical = layout === 'nhwc' ? nhwcToNchw(data, 1, channels, width, height) : data;
	return Float32Array.from(canonical.subarray(0, 4 * width * height));
}

/** Decode an ONNX VAE image and guard against WebGPU providers exposing NHWC data
 * while retaining the model's NCHW output metadata. The wrong interpretation
 * produces the characteristic repeating RGB vertical stripes. */
export function decodeVaeTensor(data: Float32Array, dims: readonly number[], mode: 'auto' | 'declared' | 'alternate' = 'auto'): DecodedTensorImage {
	if (dims.length !== 4 || dims[0] !== 1) throw new Error(`VAE 输出维度无效: ${dims.join('×')}`);
	const declaredLayout: ImageTensorLayout = dims[1] === 3 ? 'nchw' : dims[3] === 3 ? 'nhwc' : (() => { throw new Error(`VAE 输出没有 RGB 通道: ${dims.join('×')}`); })();
	const height = declaredLayout === 'nchw' ? dims[2] : dims[1];
	const width = declaredLayout === 'nchw' ? dims[3] : dims[2];
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || data.length !== width * height * 3) {
		throw new Error(`VAE 输出数据长度不匹配: ${dims.join('×')} / ${data.length}`);
	}
	const alternateLayout: ImageTensorLayout = declaredLayout === 'nchw' ? 'nhwc' : 'nchw';
	const declared = tensorPixels(data, width, height, declaredLayout);
	const alternate = tensorPixels(data, width, height, alternateLayout);
	const declaredScore = spatialDiscontinuity(declared, width, height);
	const alternateScore = spatialDiscontinuity(alternate, width, height);
	const layout = mode === 'declared' ? declaredLayout : mode === 'alternate' ? alternateLayout : alternateScore < declaredScore ? alternateLayout : declaredLayout;
	return { rgba: layout === declaredLayout ? declared : alternate, width, height, layout, declaredLayout };
}

export function ddimStep(sample: Float32Array, noise: Float32Array, timestep: number, previousTimestep: number, alphaCumprod: Float64Array): Float32Array {
	if (sample.length !== noise.length) throw new Error('DDIM tensor shape mismatch');
	const alpha = alphaCumprod[timestep];
	const previousAlpha = previousTimestep >= 0 ? alphaCumprod[previousTimestep] : 1;
	const sqrtAlpha = Math.sqrt(alpha);
	const sqrtOneMinusAlpha = Math.sqrt(1 - alpha);
	const sqrtPreviousAlpha = Math.sqrt(previousAlpha);
	const sqrtPreviousNoise = Math.sqrt(1 - previousAlpha);
	const result = new Float32Array(sample.length);
	for (let index = 0; index < sample.length; index++) {
		const predictedOriginal = (sample[index] - sqrtOneMinusAlpha * noise[index]) / sqrtAlpha;
		result[index] = sqrtPreviousAlpha * predictedOriginal + sqrtPreviousNoise * noise[index];
	}
	return result;
}

function saturate(r: number, g: number, b: number, amount: number): [number, number, number] {
	const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return [gray + (r - gray) * amount, gray + (g - gray) * amount, gray + (b - gray) * amount];
}

function paletteFor(pixels: Uint8ClampedArray, alpha: Uint8Array, count: number): Array<[number, number, number]> {
	const samples: Array<[number, number, number]> = [];
	const stride = Math.max(1, Math.floor(alpha.length / 4096));
	for (let pixel = 0; pixel < alpha.length; pixel += stride) {
		if (alpha[pixel]) samples.push([pixels[pixel * 4], pixels[pixel * 4 + 1], pixels[pixel * 4 + 2]]);
	}
	if (samples.length === 0) return [[255, 255, 255]];
	let centers = Array.from({ length: count }, (_, index) => samples[Math.floor(index * (samples.length - 1) / Math.max(1, count - 1))]);
	for (let round = 0; round < 5; round++) {
		const sums = centers.map(() => [0, 0, 0, 0]);
		for (const sample of samples) {
			let best = 0;
			let bestDistance = Infinity;
			centers.forEach((center, index) => {
				const distance = (sample[0] - center[0]) ** 2 + (sample[1] - center[1]) ** 2 + (sample[2] - center[2]) ** 2;
				if (distance < bestDistance) {
					best = index;
					bestDistance = distance;
				}
			});
			for (let channel = 0; channel < 3; channel++) sums[best][channel] += sample[channel];
			sums[best][3]++;
		}
		centers = centers.map((center, index) => sums[index][3] ? [sums[index][0] / sums[index][3], sums[index][1] / sums[index][3], sums[index][2] / sums[index][3]] : center);
	}
	return centers as Array<[number, number, number]>;
}

export function processRgba(source: Uint8ClampedArray, manufacturingMask: Uint8Array, options: RasterProcessingOptions): Uint8ClampedArray {
	if (source.length !== manufacturingMask.length * 4) throw new Error('图像与制造蒙版尺寸不一致');
	const output = new Uint8ClampedArray(source);
	const alpha = new Uint8Array(manufacturingMask.length);
	const threshold = Math.max(0, Math.min(255, options.backgroundThreshold));
	for (let pixel = 0; pixel < manufacturingMask.length; pixel++) {
		const index = pixel * 4;
		const brightness = Math.max(output[index], output[index + 1], output[index + 2]);
		alpha[pixel] = manufacturingMask[pixel] && brightness > threshold ? 1 : 0;
		const adjusted = saturate(output[index], output[index + 1], output[index + 2], Math.max(0, options.saturation));
		output[index] = adjusted[0]; output[index + 1] = adjusted[1]; output[index + 2] = adjusted[2];
	}
	const palette = paletteFor(output, alpha, Math.max(2, Math.min(8, Math.round(options.paletteSize))));
	for (let pixel = 0; pixel < manufacturingMask.length; pixel++) {
		const index = pixel * 4;
		if (!alpha[pixel]) {
			output[index + 3] = 0;
			continue;
		}
		let nearest = palette[0];
		let distance = Infinity;
		for (const candidate of palette) {
			const next = (output[index] - candidate[0]) ** 2 + (output[index + 1] - candidate[1]) ** 2 + (output[index + 2] - candidate[2]) ** 2;
			if (next < distance) { nearest = candidate; distance = next; }
		}
		output[index] = nearest[0]; output[index + 1] = nearest[1]; output[index + 2] = nearest[2];
		output[index + 3] = Math.round(255 * Math.max(0, Math.min(1, options.opacity)));
	}
	return output;
}
