export const SETTINGS_DEFAULTS = {
  artworkStyle: 'ai', circuitSeed: '12345', circuitDensity: '140', circuitLineWidth: '1.8', circuitClearance: '4',
  localModelPreset: 'inpainting', customModelUrl: '', mirrorPreset: 'huggingface',
  cloudModelSource: 'llm', imageApiUrl: '', imageModel: '', imageApiKey: '', imageSize: '1024x1024',
};

export function mirrorAddress(preset, custom) {
  return preset === 'huggingface' ? 'https://huggingface.co' : preset === 'hf-mirror' ? 'https://hf-mirror.com' : custom.trim().replace(/\/+$/, '');
}

export function settingsVisibility(config) {
  const remote = config.localModelSource !== 'imported';
  return { remote, imported: !remote, customModel: remote && config.localModelPreset === 'custom',
    customMirror: remote && config.mirrorPreset === 'custom', llm: config.cloudModelSource !== 'image',
    image: config.cloudModelSource === 'image', bbox: !remote || config.localModelPreset !== 'standard' };
}

export function loadExtraSettings(saved, $) {
  const values = { ...SETTINGS_DEFAULTS, ...saved };
  if (!saved.mirrorPreset && saved.modelMirror) values.mirrorPreset = saved.modelMirror.replace(/\/+$/, '') === 'https://huggingface.co' ? 'huggingface' : saved.modelMirror.replace(/\/+$/, '') === 'https://hf-mirror.com' ? 'hf-mirror' : 'custom';
  for (const key of Object.keys(SETTINGS_DEFAULTS)) $(key).value = values[key];
  if (saved.customMirrorAddress) $('modelMirror').value = saved.customMirrorAddress;
}

export function readExtraSettings($) {
  return { ...Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map(key => [key, $(key).value])), customMirrorAddress: $('modelMirror').value || '' };
}

export function syncSettings(config, $) {
  const visible = settingsVisibility(config);
  const circuit = config.artworkStyle === 'rainbow-circuit';
  $('circuitSettings').hidden = !circuit;
  $('engineSelector').hidden = circuit;
  $('themePromptLabel').hidden = circuit;
  $('localSettings').hidden = circuit || config.engine !== 'local';
  $('cloudSettings').hidden = circuit || config.engine !== 'cloud';
  for (const [id, show] of Object.entries({ remoteModelSettings: visible.remote, importedModelSettings: visible.imported,
    customModelLabel: visible.customModel, customMirrorLabel: visible.customMirror,
    cloudLlmSettings: visible.llm, cloudImageSettings: visible.image, avoidKeepoutsLabel: visible.bbox,
    rasterProcessingSettings: !circuit && (config.engine === 'local' || visible.image) })) $(id).hidden = !show;
  $('avoidKeepouts').disabled = !visible.bbox;
}
