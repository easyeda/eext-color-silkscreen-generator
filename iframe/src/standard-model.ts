import type { LocalModelManifest } from './local-core';
export const STANDARD_MODEL_MANIFEST: LocalModelManifest = {
	"schemaVersion": 1,
	"id": "sd15-text2img-ff52975",
	pipeline: 'text-to-image',
	"displayName": "Stable Diffusion 1.5 ONNX FP32",
	"repository": "JasonYANG170/sd15-text-to-image-onnx-fp32",
	"revision": "ff52975876c4ee29c3f39a6460339c1a70732f36",
	"license": "creativeml-openrail-m",
	"resolution": 512,
	"dtype": "fp32",
	"files": [
		{
			"path": "model_index.json",
			"size": 624,
			"sha256": "d3974849b3425857c38e818bcd173b80a5786bc5d0b4c2f104a71b2ccea5cbda"
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
			"size": 1086460,
			"sha256": "b95486f82c5f2f682b8d328d1c8f64e58f611dcf4ab597d8d545d3f9198d673c"
		},
		{
			"path": "unet/model.onnx_data",
			"size": 3438100096,
			"sha256": "7d3b30e7f0d86013e30554cd4a85dd3a3ccd17415400ae727b32b5c97ad8af13"
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
	]
};
