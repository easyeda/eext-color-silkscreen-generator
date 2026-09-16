/**
 * 入口文件 / Entry File
 *
 * 本文件为默认扩展入口文件，如果你想要配置其它文件作为入口文件，
 * 请修改 `extension.json` 中的 `entry` 字段。
 * This is the default extension entry file. If you want to use another file as the entry,
 * please modify the `entry` field in `extension.json`.
 *
 * 请在此处使用 `export`  导出所有你希望在 `headerMenus` 中引用的方法，
 * 方法通过方法名与 `headerMenus` 关联。
 * Please use `export` here to export all methods you want to reference in `headerMenus`.
 * Methods are associated with `headerMenus` by their method names.
 *
 * 如需了解更多开发细节，请阅读：
 * https://prodocs.lceda.cn/cn/api/guide/
 * For more development details, please visit:
 * https://prodocs.easyeda.com/en/api/guide/
 */
export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

export async function openGenerator(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/index.html', 1320, 820, 'easyeda-color-silkscreen', {
		title: 'AI 彩色丝印生成器',
		maximizeButton: true,
		minimizeButton: true,
		grayscaleMask: false,
	});
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		'AI 彩色丝印生成器 v0.1.29\n真实圆角板框 + 旋转 BBOX + 本地 ONNX + 云端模型。',
		'关于',
	);
}
