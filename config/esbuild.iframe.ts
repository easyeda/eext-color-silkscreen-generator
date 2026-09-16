import fs from 'node:fs';
import esbuild from 'esbuild';

const define = { 'process.env.NODE_ENV': '"production"' };

const ortJsepMjs = fs.readFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'utf8');
const ortJsepWasm = fs.readFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm').toString('base64');
const workerDefine = {
	...define,
	__ORT_JSEP_MJS_SOURCE__: JSON.stringify(ortJsepMjs),
	__ORT_JSEP_WASM_BASE64__: JSON.stringify(ortJsepWasm),
};

async function buildIframe() {
	await esbuild.build({
		entryPoints: ['iframe/app.mjs'],
		bundle: true,
		outfile: 'iframe/index.js',
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify: false,
		sourcemap: false,
		define,
	});

	await esbuild.build({
		entryPoints: ['iframe/src/local-worker.ts'],
		bundle: true,
		outfile: 'iframe/local-worker.bundle.txt',
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: false,
		sourcemap: false,
		define: workerDefine,
	});

	await esbuild.build({
		entryPoints: ['iframe/src/local-ui.ts'],
		bundle: true,
		outfile: 'iframe/local-ui.js',
		format: 'iife',
		globalName: 'EdaLocalOnnx',
		platform: 'browser',
		target: 'es2022',
		minify: false,
		sourcemap: false,
		loader: { '.txt': 'text' },
		define,
	});

	await esbuild.build({
		entryPoints: ['iframe/src/local-core.ts'],
		bundle: true,
		outfile: 'iframe/local-core.mjs',
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: false,
		sourcemap: false,
		define,
	});
}

buildIframe();
