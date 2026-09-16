# AI 彩色丝印生成器

基于 [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 的 PCB 彩色丝印生成扩展。
读取板框和器件 BBOX 作为生成条件，在浏览器内本机运行 Stable Diffusion 出图，一键写回顶层彩色丝印。

- 默认inpainting模型：[sd15-inpainting-onnx-fp32](https://huggingface.co/JasonYANG170/sd15-inpainting-onnx-fp32)
- 默认文生图模型：[sd15-text-to-image-onnx-fp32](https://huggingface.co/JasonYANG170/sd15-text-to-image-onnx-fp32)
- 默认模型镜像站：[🤗HuggingFace](https://huggingface.co/)

## 功能

### ✅ 支持本地生图模型生成彩色丝印

这个模式会在浏览器中部署一个文生图模型

#### 普通生成

普通生成模型会按照描述生成完整图片

|  图像生成 |  效果预览  |
| --- | --- |
| ![alt text](images/动画3.gif) | ![alt text](images/动画5.gif) |

#### Inpainting生成

Inpainting生成则可以根据PCB布局位置来生成对应图片

|  图像生成 |  效果预览  |
| --- | --- |
| ![alt text](images/动画6.gif) | ![alt text](images/g12.gif) |

### ✅ 支持随机脚本生成彩虹电路

这个模式下是不需要本地模型和云端API的，适合低性能设备之间生成使用。暖白底、彩色细线、按 BBOX 规划装饰路径，支持种子、密度、线宽和留白间距。

|  图像生成 |  效果预览  |
| --- | --- |
| ![alt text](images/g13.gif) | ![alt text](images/g14.gif) |

### ✅ 支持云端模型生成彩色丝印

- **LLM 模型**：OpenAI API 兼容接口，按 JSON Schema 生成 SVG 路径。（此模式效果较差，不推荐）

- **图像模型**：OpenAI API 兼容/images/generations接口，接受data[0].b64_json或图片 URL。

### 本地模式说明

#### 模型类型说明

扩展基于 ONNX Runtime Web 构建，调度器、CFG 和 latent 打包为手写实现。首次运行默认从镜像站在线拉取 ONNX 模型，若镜像站无法拉取，也可通过本地导入 ONNX 模型文件夹（可从 [HuggingFace](https://huggingface.co/) 或[魔搭社区](https://www.modelscope.cn/)获取源文件，本地导入时直接选择源文件夹即可自动解析），导入后文件会存入浏览器缓存。

仅支持 512px FP32 / PNDM epsilon 的 Diffusers ONNX 目录，不支持任意单个 `.onnx` 文件。目录导入至少需要以下文件，允许外层再包一层文件夹：

```text
model_index.json
scheduler/scheduler_config.json
tokenizer/{merges.txt,special_tokens_map.json,tokenizer_config.json,vocab.json}
text_encoder/model.onnx
unet/model.onnx
unet/model.onnx_data
vae_encoder/model.onnx
vae_decoder/model.onnx
```

#### 其他说明

1. 完全使用本地模型对配置要求较高，建议多核、高主频、大内存的设备。
2. 本地模型使用前会读取缓存、加载 ONNX、分配内存并初始化 WASM，首次使用需要一些准备时间，出现卡顿是正常现象。
3. 提示词建议使用英文，本地 CLIP tokenizer 不理解的中文词会被忽略。
4. 每次生成都会重建 Worker，连续换 seed 试效果需要重新加载 UNet 权重。

## 安装

1. 在"高级"-"扩展管理器"中导入 `.eext` 扩展文件。
2. 在"配置"中开启"允许外部交互"选项（下载模型和调用云端 API 都需要）。
3. 进入 PCB 编辑器，点击顶部导航栏"AI 彩色丝印"-"打开生成器"。

## 使用方法

1. 打开生成器后自动读取板框和器件，也可加载内置演示板检查界面。
2. 选择图案样式和引擎，本地模式首次使用先点"下载/校验模型"。
3. 填写主题提示词，点"生成"，过程中可随时取消，上一版预览会保留。
4. 用栅格处理调整配色和透明度，满意后点"应用到 PCB"，可用"撤销写回"回退。

## 致谢

- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — 浏览器端模型推理
- [Transformers.js](https://github.com/huggingface/transformers.js) — CLIP 分词
- [Diffusers](https://github.com/huggingface/diffusers) 与 [Optimum](https://github.com/huggingface/optimum) — ONNX 模型导出
- [Stable Diffusion v1.5](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5) — 开源文生图模型
- [🤗Hugging Face](https://huggingface.co/) — AI 开源社区
- [Open Neural Network Exchange](https://github.com/onnx) — ONNX 社区
