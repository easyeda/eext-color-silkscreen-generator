"use strict";
(() => {
  // iframe/settings.mjs
  var SETTINGS_DEFAULTS = {
    artworkStyle: "ai",
    circuitSeed: "12345",
    circuitDensity: "140",
    circuitLineWidth: "1.8",
    circuitClearance: "4",
    localModelPreset: "inpainting",
    customModelUrl: "",
    mirrorPreset: "huggingface",
    cloudModelSource: "llm",
    imageApiUrl: "",
    imageModel: "",
    imageApiKey: "",
    imageSize: "1024x1024"
  };
  function mirrorAddress(preset, custom) {
    return preset === "huggingface" ? "https://huggingface.co" : preset === "hf-mirror" ? "https://hf-mirror.com" : custom.trim().replace(/\/+$/, "");
  }
  function settingsVisibility(config) {
    const remote = config.localModelSource !== "imported";
    return {
      remote,
      imported: !remote,
      customModel: remote && config.localModelPreset === "custom",
      customMirror: remote && config.mirrorPreset === "custom",
      llm: config.cloudModelSource !== "image",
      image: config.cloudModelSource === "image",
      bbox: !remote || config.localModelPreset !== "standard"
    };
  }
  function loadExtraSettings(saved, $2) {
    const values = { ...SETTINGS_DEFAULTS, ...saved };
    if (!saved.mirrorPreset && saved.modelMirror) values.mirrorPreset = saved.modelMirror.replace(/\/+$/, "") === "https://huggingface.co" ? "huggingface" : saved.modelMirror.replace(/\/+$/, "") === "https://hf-mirror.com" ? "hf-mirror" : "custom";
    for (const key of Object.keys(SETTINGS_DEFAULTS)) $2(key).value = values[key];
    if (saved.customMirrorAddress) $2("modelMirror").value = saved.customMirrorAddress;
  }
  function readExtraSettings($2) {
    return { ...Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map((key) => [key, $2(key).value])), customMirrorAddress: $2("modelMirror").value || "" };
  }
  function syncSettings(config, $2) {
    const visible = settingsVisibility(config);
    const circuit = config.artworkStyle === "rainbow-circuit";
    $2("circuitSettings").hidden = !circuit;
    $2("engineSelector").hidden = circuit;
    $2("themePromptLabel").hidden = circuit;
    $2("localSettings").hidden = circuit || config.engine !== "local";
    $2("cloudSettings").hidden = circuit || config.engine !== "cloud";
    for (const [id, show] of Object.entries({
      remoteModelSettings: visible.remote,
      importedModelSettings: visible.imported,
      customModelLabel: visible.customModel,
      customMirrorLabel: visible.customMirror,
      cloudLlmSettings: visible.llm,
      cloudImageSettings: visible.image,
      avoidKeepoutsLabel: visible.bbox,
      rasterProcessingSettings: !circuit && (config.engine === "local" || visible.image)
    })) $2(id).hidden = !show;
    $2("avoidKeepouts").disabled = !visible.bbox;
  }

  // iframe/cloud-image.mjs
  function imageRequest(config, prompt) {
    if (!config.imageApiUrl || !config.imageModel || !config.imageApiKey) throw new Error("\u8BF7\u586B\u5199\u56FE\u50CF API URL\u3001\u6A21\u578B\u548C Key");
    const url = new URL(config.imageApiUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("\u56FE\u50CF API \u5FC5\u987B\u4E3A HTTP(S) \u5730\u5740");
    return { url: url.href, body: { model: config.imageModel, prompt, n: 1, size: config.imageSize } };
  }
  function imageResultUrl(data) {
    const item = data?.data?.[0];
    if (typeof item?.b64_json === "string" && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) return item.url;
    throw new Error("\u56FE\u50CF\u63A5\u53E3\u672A\u8FD4\u56DE data[0].b64_json \u6216\u6709\u6548\u56FE\u7247 URL");
  }
  async function requestCloudImage(config, prompt, signal) {
    const request = imageRequest(config, prompt);
    const response = await fetch(request.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.imageApiKey}` }, body: JSON.stringify(request.body), signal });
    if (!response.ok) throw new Error(`\u56FE\u50CF API \u8BF7\u6C42\u5931\u8D25 (${response.status})`);
    const url = imageResultUrl(await response.json());
    const image = await fetch(url, { signal });
    if (!image.ok) throw new Error(`\u4E0B\u8F7D\u751F\u6210\u56FE\u7247\u5931\u8D25 (${image.status})`);
    const bitmap = await createImageBitmap(await image.blob());
    try {
      if (signal.aborted) throw signal.reason;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const side = Math.min(bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
      return { rgba: ctx.getImageData(0, 0, 512, 512).data, rawDataUrl: canvas.toDataURL("image/png") };
    } finally {
      bitmap.close();
    }
  }

  // iframe/regions.mjs
  function regionPoints(region) {
    return Array.isArray(region?.points) && region.points.length >= 3 ? region.points : [
      { x: region.minX, y: region.minY },
      { x: region.maxX, y: region.minY },
      { x: region.maxX, y: region.maxY },
      { x: region.minX, y: region.maxY }
    ];
  }
  function pointsBounds(points) {
    return { minX: Math.min(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxX: Math.max(...points.map((p) => p.x)), maxY: Math.max(...points.map((p) => p.y)) };
  }
  function pointInRegion(point, region, padding = 0) {
    const points = regionPoints(region);
    let inside = false, minDistance = Infinity;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j], b = points[i];
      if (a.y > point.y !== b.y > point.y && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
      const t = length2 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2)) : 0;
      minDistance = Math.min(minDistance, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
    }
    return inside || minDistance <= padding;
  }
  function componentRegion(fullBox, pinPoints, category, origin, rotation = 0) {
    const angle = (Number(rotation) % 360 + 360) % 360, axisDistance = Math.min(angle % 90, 90 - angle % 90);
    if (axisDistance < 0.01 || !origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || pinPoints.length < 2) return { ...fullBox, rotation: angle };
    const radians = angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
    const local = pinPoints.map((p) => ({ x: (p.x - origin.x) * c + (p.y - origin.y) * s, y: -(p.x - origin.x) * s + (p.y - origin.y) * c }));
    const localBounds = pointsBounds(local), span = Math.max(localBounds.maxX - localBounds.minX, localBounds.maxY - localBounds.minY);
    if (span < 1) return { ...fullBox, rotation: angle };
    const margin = Math.max(8, Math.min(40, span * (category === "connector" ? 0.1 : 0.06)));
    const corners = [
      { x: localBounds.minX - margin, y: localBounds.minY - margin },
      { x: localBounds.maxX + margin, y: localBounds.minY - margin },
      { x: localBounds.maxX + margin, y: localBounds.maxY + margin },
      { x: localBounds.minX - margin, y: localBounds.maxY + margin }
    ].map((p) => ({ x: origin.x + p.x * c - p.y * s, y: origin.y + p.x * s + p.y * c }));
    return { ...fullBox, ...pointsBounds(corners), points: corners, rotation: angle };
  }

  // iframe/circuit-art.mjs
  var CIRCUIT_PALETTE = ["#dd7095", "#e6ae45", "#74bca0", "#59aac5", "#9b86b7", "#e88f65", "#89bc62"];
  function randomSeed(seed) {
    let value = seed >>> 0;
    return () => {
      value += 1831565813;
      let t = value;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var Heap = class {
    items = [];
    push(id, score) {
      const a = this.items;
      let i = a.length;
      a.push({ id, score });
      while (i) {
        const p = i - 1 >> 1;
        if (a[p].score <= score) break;
        a[i] = a[p];
        i = p;
      }
      a[i] = { id, score };
    }
    pop() {
      const a = this.items, top = a[0], last = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let child = i * 2 + 1;
          if (child + 1 < a.length && a[child + 1].score < a[child].score) child++;
          if (a[child].score >= last.score) break;
          a[i] = a[child];
          i = child;
        }
        a[i] = last;
      }
      return top;
    }
  };
  function generateCircuitArtwork(scene, options2 = {}) {
    const width = scene.viewBox.width, height = scene.viewBox.height;
    if (!(width > 0 && height > 0)) throw new Error("\u65E0\u6548\u677F\u6846\u5C3A\u5BF8");
    const seed = Number(options2.seed) >>> 0, random = randomSeed(seed);
    const density = Math.max(40, Math.min(220, Number(options2.density) || 140));
    const lineWidth = Math.max(0.7, Math.min(4, Number(options2.lineWidth) || 1.8));
    const clearance = Math.max(0, Math.min(20, Number(options2.clearance ?? 4)));
    const step = Math.max(5, width / 210, height / 210), radius = lineWidth * 1.1;
    const margin = Math.max(width * 0.012, step * 2), cols = Math.floor(width / step), rows = Math.floor(height / step), size = cols * rows;
    const blocked = new Uint8Array(size), used = new Uint8Array(size), safe = [];
    const inflate = clearance + radius + lineWidth / 2 + step * 0.75;
    const point = (id) => ({ x: (id % cols + 0.5) * step, y: (Math.floor(id / cols) + 0.5) * step });
    for (let id = 0; id < size; id++) {
      const p = point(id);
      blocked[id] = Number(p.x < margin || p.y < margin || p.x > width - margin || p.y > height - margin || scene.keepouts.some((region) => pointInRegion(p, region, inflate)) || options2.isInside && !options2.isInside(p.x, p.y, inflate));
      if (!blocked[id]) safe.push(id);
    }
    const directions = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
    const dist2 = new Float64Array(size * 8), parents = new Int32Array(size * 8), closed = new Uint8Array(size * 8);
    const heuristic = (id, goal) => {
      const dx = Math.abs(id % cols - goal % cols), dy = Math.abs(Math.floor(id / cols) - Math.floor(goal / cols));
      return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
    };
    function route(start, goal) {
      dist2.fill(Infinity);
      parents.fill(-1);
      closed.fill(0);
      const heap = new Heap();
      let visits = 0;
      for (let heading = 0; heading < 8; heading++) {
        const key = start * 8 + heading;
        dist2[key] = 0;
        heap.push(key, heuristic(start, goal));
      }
      while (heap.items.length && visits++ < 14e3) {
        const { id: key } = heap.pop();
        if (closed[key]) continue;
        const id = Math.floor(key / 8), heading = key % 8;
        if (id === goal) {
          const result = [];
          for (let p = key; p !== -1; p = parents[p]) result.push(Math.floor(p / 8));
          return new Set(result).size === result.length ? result.reverse() : null;
        }
        closed[key] = 1;
        const x = id % cols, y = Math.floor(id / cols);
        for (let direction = 0; direction < 8; direction++) {
          const delta = Math.abs(direction - heading), turnSteps = Math.min(delta, 8 - delta);
          if (turnSteps > 1) continue;
          const [dx, dy] = directions[direction], nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const next = ny * cols + nx, nextKey = next * 8 + direction;
          if (blocked[next] || used[next] || closed[nextKey]) continue;
          if (dx && dy && (blocked[y * cols + nx] || blocked[ny * cols + x] || used[y * cols + nx] || used[ny * cols + x])) continue;
          const cost = dist2[key] + (dx && dy ? 1.4142 : 1) + (turnSteps ? 0.55 : 0);
          if (cost < dist2[nextKey]) {
            dist2[nextKey] = cost;
            parents[nextKey] = key;
            heap.push(nextKey, cost + heuristic(next, goal));
          }
        }
      }
      return null;
    }
    const paths = [], routes = [];
    const number = (n) => Number(n.toFixed(2));
    function ring(p, color2, id) {
      const r = radius;
      return { id, role: "accent", d: `M ${number(p.x - r)} ${number(p.y)} A ${number(r)} ${number(r)} 0 1 0 ${number(p.x + r)} ${number(p.y)} A ${number(r)} ${number(r)} 0 1 0 ${number(p.x - r)} ${number(p.y)} Z`, fill: options2.background || "#fffdf5", stroke: color2, strokeWidth: lineWidth * 0.72, opacity: 1 };
    }
    for (let attempt = 0; attempt < density * 16 && routes.length < density; attempt++) {
      if (safe.length < 2) break;
      const start = safe[Math.floor(random() * safe.length)];
      if (used[start]) continue;
      const p = point(start), long = attempt < density * 2;
      const length = (long ? 0.2 + random() * 0.45 : 0.035 + random() * 0.13) * Math.min(width, height);
      const dx = random() < 0.5 ? 1 : -1, dy = random() < 0.5 ? 1 : -1;
      const gx = Math.max(2, Math.min(cols - 3, Math.round((p.x + dx * length) / step)));
      const gy = Math.max(2, Math.min(rows - 3, Math.round((p.y + dy * length * (0.3 + random() * 0.7)) / step)));
      const goal = gy * cols + gx;
      if (blocked[goal] || used[goal] || heuristic(start, goal) < 7) continue;
      const ids = route(start, goal);
      if (!ids || ids.length < 8) continue;
      ids.forEach((id2) => {
        used[id2] = 1;
      });
      const points = ids.map(point), simplified = points.filter((p2, i) => i === 0 || i === points.length - 1 || points[i + 1].x - p2.x !== p2.x - points[i - 1].x || points[i + 1].y - p2.y !== p2.y - points[i - 1].y);
      const color2 = CIRCUIT_PALETTE[routes.length % CIRCUIT_PALETTE.length], id = `circuit-${routes.length + 1}`;
      paths.push({ id, role: "flow", d: simplified.map((p2, i) => `${i ? "L" : "M"} ${number(p2.x)} ${number(p2.y)}`).join(" "), fill: "none", stroke: color2, strokeWidth: lineWidth, opacity: 0.94 });
      paths.push(ring(points[0], color2, `${id}-a`), ring(points.at(-1), color2, `${id}-b`));
      routes.push(points);
    }
    if (!routes.length) throw new Error("\u6CA1\u6709\u8DB3\u591F\u5F00\u653E\u533A\u57DF\u751F\u6210\u88C5\u9970\u8D70\u7EBF\uFF0C\u8BF7\u51CF\u5C0F\u7559\u767D\u95F4\u8DDD");
    return { version: 1, title: "\u5F69\u8679\u7535\u8DEF", background: options2.background || "#fffdf5", palette: CIRCUIT_PALETTE, paths, style: "rainbow-circuit", printBackground: true, seed, routes, routeCount: routes.length };
  }
  function circuitPathHits(path, spec, scene) {
    const index = Number(path.id.match(/^circuit-(\d+)/)?.[1]) - 1;
    const points = spec.routes[index] || [];
    const padding = path.strokeWidth / 2;
    return scene.keepouts.filter((region) => points.some((p) => pointInRegion(p, region, padding)));
  }

  // iframe/app.mjs
  var SVG_NS = "http://www.w3.org/2000/svg";
  var CONFIG_KEY = "easyedaColor.config.v1";
  var RESULT_KEY = "easyedaColor.result.v1";
  var DEFAULT_CONFIG = Object.freeze({
    ...SETTINGS_DEFAULTS,
    engine: "local",
    modelMirror: "https://huggingface.co",
    localModelSource: "remote",
    importedModel: "",
    localBackend: "auto",
    avoidKeepouts: true,
    localSeed: 0,
    localSteps: 10,
    localGuidance: 7,
    backgroundThreshold: 24,
    paletteSize: 6,
    rasterSaturation: 1.15,
    rasterOpacity: 1,
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-v4-flash-vision-exp",
    apiKey: "",
    temperature: 0.5,
    timeout: 60,
    autoRepair: true
  });
  var ARTWORK_SCHEMA = {
    name: "easyeda_artwork_spec",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["version", "title", "background", "palette", "paths"],
      properties: {
        version: { const: 1 },
        title: { type: "string", maxLength: 80 },
        background: { type: "string" },
        palette: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
        paths: { type: "array", minItems: 1, maxItems: 40, items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "d", "fill", "stroke", "strokeWidth", "opacity"],
          properties: {
            id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,40}$" },
            role: { enum: ["hero", "flow", "accent"] },
            d: { type: "string", maxLength: 12e3 },
            fill: { type: "string" },
            stroke: { type: "string" },
            strokeWidth: { type: "number", minimum: 0, maximum: 80 },
            opacity: { type: "number", minimum: 0, maximum: 1 }
          }
        } }
      }
    }
  };
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var PATH_CHARS = /^[0-9eE+.,\-\sMLCQAZ]+$/;
  function sanitizePathData(value) {
    if (typeof value !== "string" || value.length > 12e3 || !PATH_CHARS.test(value)) throw new Error("Path \u542B\u4E0D\u5141\u8BB8\u7684\u5B57\u7B26\u6216\u547D\u4EE4");
    const d = value.trim().replace(/\s+/g, " ");
    if (!/^M(?:\s|[-+0-9.])/.test(d) || !/[Z]$/.test(d)) throw new Error("Path \u5FC5\u987B\u4EE5\u7EDD\u5BF9 M \u5F00\u59CB\u5E76\u4EE5 Z \u95ED\u5408");
    const commands = d.match(/[A-Za-z]/g) || [];
    if (commands.some((c) => !"MLCQAZ".includes(c))) throw new Error("\u4EC5\u5141\u8BB8\u7EDD\u5BF9 M/L/C/Q/A/Z \u547D\u4EE4");
    return d;
  }
  function color(value, fallback = "none") {
    return value === "none" || HEX.test(value || "") ? value : fallback;
  }
  function validateArtworkSpec(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.paths) || !raw.paths.length) throw new Error("\u6A21\u578B\u8FD4\u56DE\u7684 ArtworkSpec \u65E0\u6548");
    const ids = /* @__PURE__ */ new Set();
    const paths = raw.paths.slice(0, 40).map((p, index) => {
      const id = String(p.id || `path-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      if (!id || ids.has(id)) throw new Error(`\u8DEF\u5F84 ID \u91CD\u590D\u6216\u65E0\u6548: ${id}`);
      ids.add(id);
      if (!["hero", "flow", "accent"].includes(p.role)) throw new Error(`\u8DEF\u5F84\u89D2\u8272\u65E0\u6548: ${id}`);
      return {
        id,
        role: p.role,
        d: sanitizePathData(p.d),
        fill: color(p.fill, "#ffffff"),
        stroke: color(p.stroke),
        strokeWidth: Math.max(0, Math.min(80, Number(p.strokeWidth) || 0)),
        opacity: Math.max(0, Math.min(1, Number(p.opacity ?? 1)))
      };
    });
    return {
      version: 1,
      title: String(raw.title || "AI Artwork").slice(0, 80),
      background: color(raw.background, "#14202b"),
      palette: (Array.isArray(raw.palette) ? raw.palette : []).map((v) => color(v, "#ffffff")).slice(0, 8),
      paths
    };
  }
  function boxesIntersect(a, b) {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  }
  function inflateBox(b, amount) {
    return { ...b, minX: b.minX - amount, minY: b.minY - amount, maxX: b.maxX + amount, maxY: b.maxY + amount };
  }
  function normalizeScene(raw) {
    const b = raw.boardBounds;
    const width = Math.max(1, b.maxX - b.minX);
    const height = Math.max(1, b.maxY - b.minY);
    const viewWidth = 1e3;
    const viewHeight = 1e3 * height / width;
    const sx = viewWidth / width;
    const sy = sx;
    const point = (x, y) => ({ x: (x - b.minX) * sx, y: (b.maxY - y) * sy });
    const box = (o) => {
      if (o.points?.length) {
        const points = o.points.map((p) => point(p.x, p.y));
        return { ...o, ...pointsBounds(points), points, rotation: o.rotation };
      }
      const p1 = point(o.minX, o.minY);
      const p2 = point(o.maxX, o.maxY);
      return { ...o, minX: Math.min(p1.x, p2.x), minY: Math.min(p1.y, p2.y), maxX: Math.max(p1.x, p2.x), maxY: Math.max(p1.y, p2.y) };
    };
    const segments = (raw.outlineSegments || []).map((s) => ({ ...s, a: point(s.a.x, s.a.y), b: point(s.b.x, s.b.y), angle: s.angle === void 0 ? void 0 : -s.angle, radius: s.radius ? s.radius * sx : void 0 }));
    const components = (raw.components || []).map(box);
    const keepouts = (raw.keepouts || raw.components || []).map(box);
    const manufacturingKeepouts = keepouts;
    return {
      version: 1,
      units: "normalized-svg",
      viewBox: { width: viewWidth, height: viewHeight },
      boardBounds: { minX: 0, minY: 0, maxX: viewWidth, maxY: viewHeight },
      sourceBounds: b,
      boardPath: stitchOutline(segments, viewWidth, viewHeight),
      components,
      keepouts,
      manufacturingKeepouts,
      anchors: findAnchors(keepouts, viewWidth, viewHeight),
      transform: { sx, sy, originX: b.minX, originY: b.maxY, flipY: true }
    };
  }
  function easyEdaImagePlacement(sourceBounds) {
    return { x: sourceBounds.minX, y: sourceBounds.maxY, width: sourceBounds.maxX - sourceBounds.minX, height: sourceBounds.maxY - sourceBounds.minY };
  }
  function rgbaPixelsToMask(pixels, pixelCount) {
    if (pixels.length !== pixelCount * 4) throw new Error("Canvas RGBA \u6570\u636E\u957F\u5EA6\u4E0D\u5339\u914D");
    const mask = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) mask[i] = pixels[i * 4] > 127 ? 255 : 0;
    return mask;
  }
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function stitchOutline(segments, width, height) {
    if (!segments.length) return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`;
    const remaining = [...segments];
    const contours = [];
    while (remaining.length) {
      let seg = remaining.shift();
      const start = seg.a;
      let current = seg.b;
      let d = `M ${fmt(start.x)} ${fmt(start.y)} ${segmentCommand(seg, false)}`;
      while (remaining.length && dist(current, start) > 1.5) {
        let best = -1, reverse = false, score = Infinity;
        remaining.forEach((candidate, i) => {
          const da = dist(current, candidate.a), db = dist(current, candidate.b);
          if (da < score) {
            best = i;
            reverse = false;
            score = da;
          }
          if (db < score) {
            best = i;
            reverse = true;
            score = db;
          }
        });
        if (score > 3) break;
        seg = remaining.splice(best, 1)[0];
        d += ` ${segmentCommand(seg, reverse)}`;
        current = reverse ? seg.a : seg.b;
      }
      contours.push(`${d} Z`);
    }
    return contours.join(" ");
  }
  function closedPointSegments(points) {
    const clean = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    if (clean.length < 3) return [];
    return clean.map((point, index) => ({ kind: "line", a: point, b: clean[(index + 1) % clean.length] }));
  }
  function polygonSourceOutline(source) {
    if (!Array.isArray(source) || source[0] !== "R" || source.length < 7) return { segments: [], bounds: void 0 };
    const [x, y, width, height, rotation, rawRadius] = source.slice(1).map(Number);
    if (![x, y, width, height, rotation, rawRadius].every(Number.isFinite) || width <= 0 || height <= 0) return { segments: [], bounds: void 0 };
    const radius = Math.max(0, Math.min(rawRadius, width / 2, height / 2)), angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const point = (dx, dy) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c });
    const corners = [point(0, 0), point(width, 0), point(width, -height), point(0, -height)];
    if (radius === 0) return { segments: closedPointSegments(corners), bounds: pointsBounds(corners) };
    const points = [point(radius, 0), point(width - radius, 0), point(width, -radius), point(width, -height + radius), point(width - radius, -height), point(radius, -height), point(0, -height + radius), point(0, -radius)];
    const segments = [];
    for (let index = 0; index < points.length; index++) segments.push({ kind: index % 2 ? "arc" : "line", a: points[index], b: points[(index + 1) % points.length], angle: index % 2 ? -90 : void 0, radius: index % 2 ? radius : void 0 });
    return { segments, bounds: pointsBounds(corners) };
  }
  function segmentCommand(s, reverse) {
    const end = reverse ? s.a : s.b;
    if (s.kind !== "arc") return `L ${fmt(end.x)} ${fmt(end.y)}`;
    const angle = (Number(s.angle) || 0) * (reverse ? -1 : 1);
    return `A ${fmt(Math.abs(s.radius || 1))} ${fmt(Math.abs(s.radius || 1))} 0 ${Math.abs(angle) > 180 ? 1 : 0} ${angle >= 0 ? 1 : 0} ${fmt(end.x)} ${fmt(end.y)}`;
  }
  function fmt(n) {
    return Number(n.toFixed(3));
  }
  function findAnchors(keepouts, width, height) {
    const candidates = [
      { name: "center", x: 0.5 * width, y: 0.5 * height },
      { name: "upper-left", x: 0.24 * width, y: 0.25 * height },
      { name: "upper-right", x: 0.76 * width, y: 0.25 * height },
      { name: "lower-left", x: 0.24 * width, y: 0.75 * height },
      { name: "lower-right", x: 0.76 * width, y: 0.75 * height }
    ];
    return candidates.map((a) => ({ ...a, clearance: keepouts.reduce((m, b) => Math.min(m, Math.hypot(a.x - (b.minX + b.maxX) / 2, a.y - (b.minY + b.maxY) / 2)), Infinity) })).sort((a, b) => b.clearance - a.clearance).slice(0, 3);
  }
  function getLayer(name) {
    const value = globalThis.EPCB_LayerId?.[name];
    if (value === void 0) throw new Error(`EasyEDA \u672A\u63D0\u4F9B EPCB_LayerId.${name}\uFF0C\u8BF7\u5347\u7EA7\u4E13\u4E1A\u7248\u5BA2\u6237\u7AEF`);
    return value;
  }
  function componentCategory(designator, name) {
    const s = `${designator} ${name}`.toUpperCase();
    if (/USB|TYPE.?C|CONN|J\d/.test(s)) return "connector";
    if (/LED|D\d/.test(s)) return "led";
    if (/MCU|ESP|STM|RP\d|U\d/.test(s)) return "ic";
    if (/SW|KEY|BTN/.test(s)) return "button";
    if (/H\d|HOLE|SCREW|MOUNT/.test(s)) return "mounting-hole";
    return "component";
  }
  function chooseComponentBox(fullBox, pinBox, category) {
    if (!pinBox || category === "connector" || category === "mounting-hole") return inflateBox(fullBox, 8);
    const width = Math.max(1, pinBox.maxX - pinBox.minX), height = Math.max(1, pinBox.maxY - pinBox.minY);
    const margin = Math.max(8, Math.min(40, Math.max(width, height) * 0.06));
    return inflateBox(pinBox, margin);
  }
  async function readEasyEdaScene() {
    if (!globalThis.eda) throw new Error("\u4EC5\u80FD\u5728 EasyEDA Pro \u6269\u5C55 iframe \u4E2D\u8BFB\u53D6 PCB");
    const outlineLayer = getLayer("BOARD_OUTLINE");
    const readPolylines = async () => {
      try {
        return await eda.pcb_PrimitivePolyline?.getAll?.(void 0, outlineLayer) || [];
      } catch {
        return [];
      }
    };
    const [lines, arcs, polylines, components] = await Promise.all([
      eda.pcb_PrimitiveLine.getAll(void 0, outlineLayer),
      eda.pcb_PrimitiveArc.getAll(void 0, outlineLayer),
      readPolylines(),
      eda.pcb_PrimitiveComponent.getAll()
    ]);
    const outline = [...lines, ...arcs, ...polylines];
    const outlineBox = outline.length ? await eda.pcb_Primitive.getPrimitivesBBox(outline) : void 0;
    const compBoxes = [];
    for (const comp of components) {
      const designator = String(comp.getState_Designator?.() || "");
      const name = String(comp.getState_Name?.() || comp.getState_Component?.()?.name || "");
      const category = componentCategory(designator, name);
      const id = comp.getState_PrimitiveId();
      const b = await eda.pcb_Primitive.getPrimitivesBBox([comp]).catch(() => void 0);
      if (!b) continue;
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id).catch(() => void 0);
      const pinBox = pins?.length ? await eda.pcb_Primitive.getPrimitivesBBox(pins).catch(() => void 0) : void 0;
      const base = chooseComponentBox(b, pinBox, category), pinPoints = (pins || []).map((p) => ({ x: Number(p.getState_X?.()), y: Number(p.getState_Y?.()) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      const region = componentRegion(base, pinPoints, category, { x: Number(comp.getState_X?.()), y: Number(comp.getState_Y?.()) }, Number(comp.getState_Rotation?.()) || 0);
      compBoxes.push({ ...region, id, designator, name, category, type: "component" });
    }
    const polylineOutlines = polylines.map((p) => {
      try {
        return polygonSourceOutline(p.getState_Polygon().getSource());
      } catch {
        return { segments: [], bounds: void 0 };
      }
    });
    const exactPolylineBounds = polylineOutlines.map((o) => o.bounds).filter(Boolean);
    let boardBounds = !lines.length && !arcs.length && exactPolylineBounds.length ? { minX: Math.min(...exactPolylineBounds.map((b) => b.minX)), minY: Math.min(...exactPolylineBounds.map((b) => b.minY)), maxX: Math.max(...exactPolylineBounds.map((b) => b.maxX)), maxY: Math.max(...exactPolylineBounds.map((b) => b.maxY)) } : outlineBox;
    if (!boardBounds) {
      const all = [...compBoxes];
      if (!all.length) throw new Error("\u5F53\u524D PCB \u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u677F\u6846\u6216\u5668\u4EF6");
      boardBounds = inflateBox({ minX: Math.min(...all.map((x) => x.minX)), minY: Math.min(...all.map((x) => x.minY)), maxX: Math.max(...all.map((x) => x.maxX)), maxY: Math.max(...all.map((x) => x.maxY)) }, 100);
    }
    const outlineSegments = [
      ...lines.map((l) => ({ kind: "line", a: { x: l.getState_StartX(), y: l.getState_StartY() }, b: { x: l.getState_EndX(), y: l.getState_EndY() } })),
      ...arcs.map((a) => {
        const p = { x: a.getState_StartX(), y: a.getState_StartY() };
        const q = { x: a.getState_EndX(), y: a.getState_EndY() };
        const angle = a.getState_ArcAngle();
        const radius = dist(p, q) / (2 * Math.max(1e-3, Math.abs(Math.sin(angle * Math.PI / 360))));
        return { kind: "arc", a: p, b: q, angle, radius };
      })
    ];
    polylineOutlines.forEach((outline2) => outlineSegments.push(...outline2.segments));
    return normalizeScene({ boardBounds, outlineSegments, components: compBoxes, keepouts: compBoxes });
  }
  function demoScene() {
    const raw = { boardBounds: { minX: 0, minY: 0, maxX: 1600, maxY: 900 }, outlineSegments: [
      { kind: "line", a: { x: 0, y: 80 }, b: { x: 80, y: 0 } },
      { kind: "line", a: { x: 80, y: 0 }, b: { x: 1520, y: 0 } },
      { kind: "line", a: { x: 1520, y: 0 }, b: { x: 1600, y: 80 } },
      { kind: "line", a: { x: 1600, y: 80 }, b: { x: 1600, y: 820 } },
      { kind: "line", a: { x: 1600, y: 820 }, b: { x: 1520, y: 900 } },
      { kind: "line", a: { x: 1520, y: 900 }, b: { x: 80, y: 900 } },
      { kind: "line", a: { x: 80, y: 900 }, b: { x: 0, y: 820 } },
      { kind: "line", a: { x: 0, y: 820 }, b: { x: 0, y: 80 } }
    ], components: [
      { id: "U1", designator: "U1", name: "ESP32-S3", category: "ic", type: "component", minX: 620, minY: 280, maxX: 980, maxY: 620 },
      { id: "J1", designator: "J1", name: "USB-C", category: "connector", type: "component", minX: 0, minY: 330, maxX: 230, maxY: 570 },
      { id: "D1", designator: "D1", name: "RGB LED", category: "led", type: "component", minX: 1260, minY: 160, maxX: 1400, maxY: 300 },
      { id: "SW1", designator: "SW1", name: "BOOT", category: "button", type: "component", minX: 1240, minY: 650, maxX: 1440, maxY: 810 }
    ], keepouts: [] };
    raw.keepouts = [...raw.components, { id: "H1", type: "mounting-hole", minX: 90, minY: 80, maxX: 190, maxY: 180 }, { id: "H2", type: "mounting-hole", minX: 1410, minY: 720, maxX: 1510, maxY: 820 }];
    return normalizeScene(raw);
  }
  function compactScene(scene) {
    return {
      version: 1,
      coordinateSystem: `0 0 ${scene.viewBox.width} ${scene.viewBox.height}`,
      boardPath: scene.boardPath,
      keepouts: scene.keepouts.map(({ id, type, designator, name, category, minX, minY, maxX, maxY, points, rotation }) => ({ id, type, designator, name, category, minX: fmt(minX), minY: fmt(minY), maxX: fmt(maxX), maxY: fmt(maxY), rotation, points: points?.map((p) => ({ x: fmt(p.x), y: fmt(p.y) })) })),
      anchors: scene.anchors.map((a) => ({ ...a, x: fmt(a.x), y: fmt(a.y), clearance: fmt(a.clearance) }))
    };
  }
  function promptFor(scene, theme, repair) {
    const repairText = repair ? `
\u8FD9\u662F\u552F\u4E00\u4E00\u6B21\u4FEE\u590D\u3002\u51B2\u7A81\u6E05\u5355\uFF1A${JSON.stringify(repair)}\u3002\u79FB\u52A8\u6216\u91CD\u7ED8\u8FD9\u4E9B\u8DEF\u5F84\uFF0C\u4FDD\u6301\u4E3B\u4F53\u8FA8\u8BC6\u5EA6\u3002` : "";
    return `\u4F60\u662F PCB \u5F69\u8272\u4E1D\u5370\u8BBE\u8BA1\u5E08\u3002\u6839\u636E\u56FE\u7247\u548C\u7CBE\u786E JSON \u53EA\u8FD4\u56DE\u7B26\u5408 schema \u7684 ArtworkSpec\u3002\u4E3B\u9898\uFF1A${theme}
\u5750\u6807\u5FC5\u987B\u5904\u4E8E viewBox\u3002\u5EFA\u7ACB\u4E09\u5C42\u5C42\u7EA7\uFF1A1 \u4E2A\u6E05\u6670\u4E3B\u4F53 hero\u30011\u20133 \u4E2A\u5BBD\u95ED\u5408 flow\u30013\u20138 \u4E2A\u5927\u5C0F\u4E0D\u540C\u4E14\u4E0D\u89C4\u5219\u5206\u5E03\u7684 accent\u3002\u4E3B\u4F53\u5FC5\u987B\u662F\u53EF\u8FA8\u8BC6\u7684\u95ED\u5408\u586B\u5145\u8F6E\u5ED3\uFF1B\u6D41\u7EBF\u662F\u5BBD\u95ED\u5408\u8272\u5E26\uFF0C\u4E0D\u80FD\u9760\u7EC6 stroke\uFF1B\u4E0D\u8981\u91CD\u590D\u7F51\u683C\u3002\u4EFB\u4F55\u56FE\u6848\u4E0D\u5F97\u7A7F\u8FC7\u7EA2\u8272\u5668\u4EF6\u7981\u533A\u6216\u677F\u5916\u3002\u710A\u76D8\u548C\u8FC7\u5B54\u4E0D\u51FA\u73B0\u5728\u573A\u666F SVG \u4E2D\uFF0C\u6700\u7EC8\u7531\u672C\u5730\u5236\u9020\u8499\u7248\u5F3A\u5236\u88C1\u526A\u3002\u4F18\u5148\u4F7F\u7528 JSON \u4E2D clearance \u6700\u5927\u7684 anchors\u3002\u6240\u6709 d \u53EA\u80FD\u7528\u7EDD\u5BF9 M/L/C/Q/A/Z \u5E76\u4EE5 Z \u95ED\u5408\u3002stroke \u4E0D\u7528\u65F6\u5199 none\u3002Few-shot: \u8760\u9CBC\u4E3B\u4F53\u53EF\u7528\u201CM 250 350 C 330 260 430 260 500 350 C 430 330 390 410 375 470 C 350 420 330 350 250 350 Z\u201D\uFF1B\u6D41\u7EBF\u53EF\u7528\u201CM 80 650 C 300 520 650 560 900 430 L 900 470 C 650 610 300 570 80 690 Z\u201D\u3002\u53CD\u4F8B\uFF1A\u7A7F\u8FC7\u5668\u4EF6\u3001\u7B49\u8DDD\u5706\u70B9\u9635\u5217\u3001\u5F00\u653E\u4E3B\u4F53\u8F6E\u5ED3\u3002${repairText}
\u7CBE\u786E\u573A\u666F JSON\uFF1A${JSON.stringify(compactScene(scene))}`;
  }
  async function svgToDataUrl(svg, mime = "image/png", maxPixels = 1400) {
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = fail;
        img.src = url;
      });
      const vb = svg.viewBox.baseVal;
      const scale = Math.min(maxPixels / vb.width, maxPixels / vb.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vb.width * scale));
      canvas.height = Math.max(1, Math.round(vb.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(mime);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function callModel(config, scene, sceneImage2, theme, signal, repair) {
    const body = {
      model: config.model,
      temperature: Number(config.temperature),
      max_tokens: 5e3,
      reasoning: { effort: "none", exclude: true },
      response_format: { type: "json_schema", json_schema: ARTWORK_SCHEMA },
      messages: [{ role: "user", content: [{ type: "text", text: promptFor(scene, theme, repair) }, { type: "image_url", image_url: { url: sceneImage2 } }] }]
    };
    const response = await fetch(config.apiUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, "HTTP-Referer": "https://pro.easyeda.com", "X-Title": "EasyEDA Color Silkscreen" }, body: JSON.stringify(body), signal });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json())?.error?.message || "";
      } catch {
      }
      throw new Error(`API ${response.status}: ${detail || response.statusText}`);
    }
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error("\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9");
    return validateArtworkSpec(typeof content === "string" ? JSON.parse(content) : content);
  }
  function el(name, attrs = {}, textValue) {
    const n = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    if (textValue !== void 0) n.textContent = textValue;
    return n;
  }
  function pathBBox(d) {
    const svg = el("svg");
    svg.style.position = "absolute";
    svg.style.visibility = "hidden";
    const p = el("path", { d });
    svg.append(p);
    document.body.append(svg);
    try {
      const b = p.getBBox();
      return { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
    } finally {
      svg.remove();
    }
  }
  function conflictReport(spec, scene) {
    if (spec.style === "rainbow-circuit") return spec.paths.map((p) => ({ id: p.id, role: p.role, bbox: pathBBox(p.d), hits: circuitPathHits(p, spec, scene).map((k) => k.id), ratio: 0 }));
    return spec.paths.map((p) => {
      const b = pathBBox(p.d);
      const hits = scene.keepouts.filter((k) => boxesIntersect(b, k));
      const area = Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY));
      const overlap = hits.reduce((sum, k) => {
        const w = Math.max(0, Math.min(b.maxX, k.maxX) - Math.max(b.minX, k.minX));
        const h = Math.max(0, Math.min(b.maxY, k.maxY) - Math.max(b.minY, k.minY));
        return sum + w * h;
      }, 0);
      return { id: p.id, role: p.role, bbox: b, hits: hits.map((h) => h.id), ratio: Math.min(1, overlap / area) };
    });
  }
  function createSvg(scene, spec, options2 = {}) {
    const { width, height } = scene.viewBox;
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, "data-kind": "easyeda-color-artwork" });
    const defs = el("defs");
    const mask = el("mask", { id: "manufacturing-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width, height });
    mask.append(el("path", { d: scene.boardPath, fill: "white", stroke: "black", "stroke-width": Math.max(4, width * 0.012), "fill-rule": "evenodd" }));
    const regionElement = (region, attrs = {}) => region.points?.length ? el("polygon", { points: regionPoints(region).map((p) => `${p.x},${p.y}`).join(" "), ...attrs }) : el("rect", { x: region.minX, y: region.minY, width: region.maxX - region.minX, height: region.maxY - region.minY, rx: Math.min(8, (region.maxX - region.minX) / 4), ...attrs });
    const activeKeepouts = spec?.kind === "raster" ? [] : scene.keepouts;
    activeKeepouts.forEach((k) => mask.append(regionElement(k, { fill: "black" })));
    defs.append(mask);
    svg.append(defs);
    svg.append(el("path", { d: scene.boardPath, fill: options2.transparent ? "none" : spec?.background || "#14202b", stroke: options2.transparent ? "none" : "#4c6378", "stroke-width": 2, "fill-rule": "evenodd" }));
    const original = el("g", { class: "original-art", "data-layer": "original" });
    const clipped = el("g", { mask: "url(#manufacturing-mask)", "data-layer": "artwork" });
    if (spec?.printBackground) clipped.append(el("path", { d: scene.boardPath, fill: spec.background, "fill-rule": "evenodd" }));
    if (spec?.kind === "raster") {
      const m = spec.mapping;
      const href = options2.rasterView === "raw" ? spec.rawDataUrl : spec.processedDataUrl;
      const attrs = { href, x: -m.offsetX * width / m.drawWidth, y: -m.offsetY * height / m.drawHeight, width: 512 * width / m.drawWidth, height: 512 * height / m.drawHeight, preserveAspectRatio: "none" };
      original.append(el("image", { ...attrs, href: spec.rawDataUrl }));
      clipped.append(el("image", attrs));
    } else (spec?.paths || []).forEach((p) => {
      const attrs = { d: p.d, fill: p.fill, stroke: p.stroke, "stroke-width": p.strokeWidth, opacity: p.opacity, "data-id": p.id, class: "art-path", "fill-rule": "evenodd" };
      original.append(el("path", attrs));
      clipped.append(el("path", attrs));
    });
    original.style.display = options2.showOriginal ? "" : "none";
    svg.append(original, clipped);
    const comps = el("g", { "data-layer": "components" });
    scene.components.forEach((c) => {
      comps.append(regionElement(c, { class: "component" }));
      comps.append(el("text", { x: c.minX + 4, y: c.minY + 14, fill: "#cbd5e1", "font-size": 11 }, `${c.designator || ""} ${c.category || ""}`));
    });
    comps.style.display = options2.showComponents === false ? "none" : "";
    svg.append(comps);
    const keeps = el("g", { "data-layer": "keepouts" });
    scene.keepouts.forEach((k) => keeps.append(regionElement(k, { class: "keepout" })));
    keeps.style.display = options2.showKeepouts === false ? "none" : "";
    svg.append(keeps);
    return svg;
  }
  function deepCopy(v) {
    return JSON.parse(JSON.stringify(v));
  }
  var state = { scene: null, spec: null, raster: null, history: [], selected: null, controller: null, localBusy: false, manufacturingMask: null, view: { x: 0, y: 0, w: 1e3, h: 600 }, lastAppliedId: null };
  var $ = (id) => document.getElementById(id);
  async function loadConfig() {
    let saved = {};
    try {
      saved = globalThis.eda?.sys_Storage?.getExtensionUserConfig(CONFIG_KEY) || {};
      if (typeof saved === "string") saved = JSON.parse(saved);
    } catch {
    }
    const c = { ...DEFAULT_CONFIG, ...saved };
    ["apiUrl", "model", "apiKey", "temperature", "timeout", "modelMirror", "localModelSource", "importedModel", "localBackend", "localSeed", "localSteps", "localGuidance", "backgroundThreshold", "paletteSize", "rasterSaturation", "rasterOpacity"].forEach((k) => {
      if ($(k)) $(k).value = c[k];
    });
    $("avoidKeepouts").checked = c.avoidKeepouts === true;
    $("autoRepair").checked = c.autoRepair !== false;
    loadExtraSettings(saved, $);
    setEngine(c.engine === "cloud" ? "cloud" : "local");
    syncSettings(currentConfig(), $);
    return c;
  }
  function currentConfig() {
    return { ...readExtraSettings($), engine: $("localEngineBtn").classList.contains("active") ? "local" : "cloud", modelMirror: mirrorAddress($("mirrorPreset").value, $("modelMirror").value), localModelSource: $("localModelSource").value, importedModel: $("importedModel").value, localBackend: $("localBackend").value, avoidKeepouts: !$("avoidKeepouts").disabled && $("avoidKeepouts").checked, localSeed: Number($("localSeed").value) >>> 0, localSteps: Number($("localSteps").value), localGuidance: Number($("localGuidance").value), backgroundThreshold: Number($("backgroundThreshold").value), paletteSize: Number($("paletteSize").value), rasterSaturation: Number($("rasterSaturation").value), rasterOpacity: Number($("rasterOpacity").value), apiUrl: $("apiUrl").value.trim(), model: $("model").value.trim(), apiKey: $("apiKey").value.trim(), temperature: Number($("temperature").value), timeout: Number($("timeout").value), autoRepair: $("autoRepair").checked };
  }
  async function saveConfig() {
    const c = currentConfig();
    if (c.artworkStyle !== "rainbow-circuit" && c.engine === "cloud" && (c.cloudModelSource === "image" ? !c.imageApiUrl || !c.imageModel : !c.apiUrl || !c.model)) throw new Error("API URL \u548C\u6A21\u578B\u4E0D\u80FD\u4E3A\u7A7A");
    await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, c);
    status("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
  }
  function status(text) {
    $("status").textContent = text;
  }
  function options() {
    return { showOriginal: $("showOriginal").checked, showComponents: $("showComponents").checked, showKeepouts: $("showKeepouts").checked, rasterView: $("rasterView").value };
  }
  function currentArtwork() {
    return state.raster || state.spec;
  }
  function setEngine(engine) {
    const local = engine === "local";
    $("localEngineBtn").classList.toggle("active", local);
    $("cloudEngineBtn").classList.toggle("active", !local);
    $("localSettings").hidden = !local;
    $("cloudSettings").hidden = local;
    $("rasterViewLabel").hidden = !state.raster;
    $("pathEditor").hidden = true;
    syncSettings(currentConfig(), $);
    if (state.scene) render();
  }
  function render() {
    if (!state.scene) return;
    $("rasterViewLabel").hidden = !state.raster;
    const artwork = currentArtwork();
    const svg = createSvg(state.scene, artwork, options());
    svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
    $("stage").replaceChildren(svg);
    $("emptyState").style.display = "none";
    svg.querySelectorAll(".art-path").forEach((p) => p.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPath(p.dataset.id);
    }));
    if (state.spec) {
      const report = conflictReport(state.spec, state.scene);
      if ($("showConflicts").checked) {
        const g = el("g", { "data-layer": "conflicts" });
        report.filter((r) => r.hits.length).forEach((r) => g.append(el("rect", { x: r.bbox.minX, y: r.bbox.minY, width: r.bbox.maxX - r.bbox.minX, height: r.bbox.maxY - r.bbox.minY, class: "conflict" })));
        svg.append(g);
      }
      renderPathList(report);
      $("diagnostics").textContent = diagnosticText(report);
    } else if (state.raster) {
      $("pathList").replaceChildren();
      $("pathEditor").hidden = true;
      const layout = state.raster.imageLayout ? `
UNet \u5185\u6838 ${state.raster.unetKernelLayout || "unknown"} \xB7 VAE ${state.raster.vaeBackend || "unknown"} \xB7 ${state.raster.vaeDecodeMode || "unknown"} \xB7 \u8F93\u51FA ${state.raster.declaredImageLayout || "unknown"} \u2192 ${state.raster.imageLayout}` : "";
      const scheduler = state.raster.scheduler ? `
\u8C03\u5EA6\u5668 ${state.raster.scheduler}` : "";
      const conditioning = state.raster.conditioningDelta !== void 0 ? `
\u63D0\u793A\u8BCD\u6761\u4EF6\u5DEE ${state.raster.conditioningDelta.toFixed(5)} \xB7 ${state.raster.differingTokenCount} \u4E2A\u5DEE\u5F02 token` : "";
      const constraint = state.raster.constraintMode ? `
\u7EA6\u675F ${state.raster.constraintMode} \xB7 latent \u5F00\u653E\u7387 ${Math.round((state.raster.latentSafeRatio ?? 1) * 100)}%` : "";
      const avoidance = state.raster.backend === "cloud" ? "\u4E91\u7AEF\u56FE\u50CF\u6309\u63D0\u793A\u8BCD\u751F\u6210\uFF0C\u672A\u8F93\u5165 BBOX \u8499\u7248" : state.raster.avoidKeepouts ? `\u5DF2\u5C06 SVG \u7684 ${state.scene.keepouts.length} \u4E2A\u5668\u4EF6\u6846\u4F5C\u4E3A Inpainting \u80CC\u666F\u6761\u4EF6\u8F93\u5165\uFF1B\u8BF7\u68C0\u67E5\u539F\u56FE\u4E2D\u7684\u4FDD\u7559\u6548\u679C` : "\u672A\u542F\u7528 BBOX \u7559\u767D";
      $("diagnostics").textContent = `${state.raster.backend === "cloud" ? "\u4E91\u7AEF\u56FE\u50CF" : "\u672C\u5730 ONNX"} \u6805\u683C\u4F5C\u54C1
\u6A21\u578B ${state.raster.model.id}
revision ${state.raster.model.revision}
\u540E\u7AEF ${state.raster.backend} \xB7 ${state.raster.steps} \u6B65 \xB7 seed ${state.raster.seed}${layout}${scheduler}${conditioning}${constraint}

${avoidance}\uFF1B\u710A\u76D8\u548C\u8FC7\u5B54\u4E0D\u53C2\u4E0E\u7EA6\u675F\u3002`;
    } else {
      $("pathList").replaceChildren();
      $("diagnostics").textContent = "\u5C1A\u672A\u751F\u6210";
    }
    $("sceneStats").textContent = `\u677F\u9762 ${Math.round(state.scene.sourceBounds.maxX - state.scene.sourceBounds.minX)} \xD7 ${Math.round(state.scene.sourceBounds.maxY - state.scene.sourceBounds.minY)} mil
\u5668\u4EF6\u6846 ${state.scene.components.length}
\u6709\u6548\u7981\u533A ${state.scene.keepouts.length}\uFF08\u4EC5 SVG \u53EF\u89C1\u533A\u57DF\uFF09
\u951A\u70B9 ${state.scene.anchors.map((a) => a.name).join("\u3001")}`;
  }
  function diagnosticText(report) {
    const hit = report.filter((r) => r.hits.length);
    return hit.length ? `${hit.length} \u6761\u8DEF\u5F84\u4E0E\u539F\u59CB BBOX \u76F8\u4EA4\u3002
${hit.map((r) => `${r.id}: ${r.hits.join(", ")} (${Math.round(r.ratio * 100)}%)`).join("\n")}

\u6700\u7EC8 PNG \u5DF2\u5F3A\u5236\u5E94\u7528\u5236\u9020\u8499\u7248\u3002` : "\u672A\u68C0\u6D4B\u5230 BBOX \u51B2\u7A81\uFF1B\u6700\u7EC8\u4ECD\u4F1A\u5E94\u7528\u5236\u9020\u8499\u7248\u3002";
  }
  function renderPathList(report) {
    $("pathList").replaceChildren(...state.spec.paths.map((p) => {
      const r = report.find((x) => x.id === p.id);
      const n = document.createElement("div");
      const swatch = document.createElement("i");
      const name = document.createElement("span");
      const badge = document.createElement("small");
      n.className = `path-item${state.selected === p.id ? " selected" : ""}`;
      swatch.className = "swatch";
      badge.className = "badge";
      swatch.style.background = p.fill === "none" ? p.stroke : p.fill;
      name.textContent = p.id;
      badge.textContent = `${p.role}${r?.hits.length ? " \xB7 \u51B2\u7A81" : ""}`;
      n.append(swatch, name, badge);
      n.onclick = () => selectPath(p.id);
      return n;
    }));
  }
  function selectPath(id) {
    state.selected = id;
    const p = state.spec?.paths.find((x) => x.id === id);
    $("pathEditor").hidden = !p;
    if (p) {
      const item = conflictReport(state.spec, state.scene).find((r) => r.id === id);
      $("pathTitle").textContent = p.id;
      $("pathFill").value = p.fill === "none" ? "#ffffff" : p.fill;
      $("pathStroke").value = p.stroke === "none" ? "#000000" : p.stroke;
      $("pathOpacity").value = p.opacity;
      $("pathMeta").textContent = `\u89D2\u8272 ${p.role}\uFF1B${item?.hits.length ? `\u51B2\u7A81 ${item.hits.join("\u3001")}` : "\u65E0 BBOX \u51B2\u7A81"}`;
    }
    render();
  }
  function cloneArtwork() {
    return state.raster ? { type: "raster", value: { ...state.raster, rawRgba: new Uint8ClampedArray(state.raster.rawRgba), mask: new Uint8Array(state.raster.mask) } } : state.spec ? { type: "vector", value: deepCopy(state.spec) } : null;
  }
  function pushHistory() {
    const item = cloneArtwork();
    if (item) {
      state.history.push(item);
      if (state.history.length > 20) state.history.shift();
    }
  }
  async function scan(useDemo = false) {
    try {
      status("\u6B63\u5728\u8BFB\u53D6 PCB\u2026");
      state.scene = useDemo ? demoScene() : await readEasyEdaScene();
      state.spec = null;
      state.raster = null;
      state.manufacturingMask = createManufacturingMask(state.scene);
      state.selected = null;
      fit();
      render();
      $("generateBtn").disabled = false;
      status(useDemo ? "\u5DF2\u52A0\u8F7D\u5185\u7F6E\u6F14\u793A\u677F" : "PCB \u573A\u666F\u5DF2\u8BFB\u53D6");
    } catch (e) {
      status(`\u8BFB\u53D6\u5931\u8D25\uFF1A${e.message}`);
      if (!useDemo) $("emptyState").style.display = "flex";
    }
  }
  function createManufacturingMask(scene, size = 512, avoidKeepouts = true) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const scale = Math.min(size / scene.viewBox.width, size / scene.viewBox.height);
    const drawWidth = scene.viewBox.width * scale, drawHeight = scene.viewBox.height * scale, offsetX = (size - drawWidth) / 2, offsetY = (size - drawHeight) / 2;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = Math.max(4, scene.viewBox.width * 0.012);
    const board = new Path2D(scene.boardPath);
    ctx.fill(board, "evenodd");
    ctx.stroke(board);
    ctx.fillStyle = "#000";
    (avoidKeepouts ? scene.keepouts : []).forEach((k) => {
      const points = regionPoints(k);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const mask = rgbaPixelsToMask(pixels, size * size);
    return { mask, mapping: { offsetX, offsetY, drawWidth, drawHeight, scale } };
  }
  async function sceneImage(withArtwork = false) {
    const svg = createSvg(state.scene, withArtwork ? state.spec : null, { showComponents: true, showKeepouts: true, transparent: false });
    if (withArtwork && state.spec) {
      const report = conflictReport(state.spec, state.scene);
      const g = el("g", { "data-layer": "repair-conflicts" });
      report.filter((r) => r.hits.length).forEach((r) => g.append(el("rect", { x: r.bbox.minX, y: r.bbox.minY, width: r.bbox.maxX - r.bbox.minX, height: r.bbox.maxY - r.bbox.minY, fill: "#ff000088", stroke: "#ff0000", "stroke-width": 5 })));
      svg.append(g);
    }
    return svgToDataUrl(svg, "image/png", 1200);
  }
  async function generateCloud() {
    if (!state.scene) return;
    const config = currentConfig();
    if (!config.apiKey) {
      status("\u8BF7\u5148\u586B\u5199 API Key");
      $("apiKey").focus();
      return;
    }
    if (currentArtwork()) pushHistory();
    state.controller = new AbortController();
    const timer = setTimeout(() => state.controller.abort(new DOMException("60 \u79D2\u8D85\u65F6", "TimeoutError")), Math.max(10, config.timeout) * 1e3);
    $("generateBtn").disabled = true;
    $("cancelBtn").disabled = false;
    status("\u6A21\u578B\u6B63\u5728\u751F\u6210\uFF0C\u4FDD\u7559\u4E0A\u4E00\u7248\u9884\u89C8\u2026");
    try {
      const image = await sceneImage(false);
      let spec = await callModel(config, state.scene, image, $("themePrompt").value, state.controller.signal);
      state.spec = spec;
      state.raster = null;
      render();
      let report = conflictReport(spec, state.scene);
      const severe = report.filter((r) => r.role === "hero" && r.ratio > 0.16 || r.ratio > 0.32);
      if (config.autoRepair && severe.length) {
        status(`\u4E3B\u4F53\u51B2\u7A81\u8F83\u91CD\uFF0C\u6B63\u5728\u6267\u884C\u552F\u4E00\u4E00\u6B21\u89C6\u89C9\u4FEE\u590D\u2026`);
        const repairImage = await sceneImage(true);
        spec = await callModel(config, state.scene, repairImage, $("themePrompt").value, state.controller.signal, severe.map((r) => ({ pathId: r.id, hitIds: r.hits, suggestedDirection: suggestDirection(r.bbox, state.scene) })));
        state.spec = spec;
        state.raster = null;
        render();
        report = conflictReport(spec, state.scene);
      }
      $("applyBtn").disabled = false;
      status(`\u751F\u6210\u5B8C\u6210\uFF1A${spec.paths.length} \u6761\u8DEF\u5F84\uFF0C${report.filter((r) => r.hits.length).length} \u6761\u7ECF\u5236\u9020\u8499\u7248\u88C1\u526A`);
    } catch (e) {
      if (e.name === "AbortError" || e.name === "TimeoutError") status("\u751F\u6210\u5DF2\u53D6\u6D88\u6216\u8D85\u65F6\uFF0C\u4E0A\u4E00\u6709\u6548\u7248\u672C\u5DF2\u4FDD\u7559");
      else status(`\u751F\u6210\u5931\u8D25\uFF1A${e.message}`);
    } finally {
      clearTimeout(timer);
      state.controller = null;
      $("generateBtn").disabled = false;
      $("cancelBtn").disabled = true;
    }
  }
  function suggestDirection(b, scene) {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return `${cx < scene.viewBox.width / 2 ? "right" : "left"}-${cy < scene.viewBox.height / 2 ? "down" : "up"}`;
  }
  function processingOptions() {
    return { backgroundThreshold: Number($("backgroundThreshold").value), paletteSize: Number($("paletteSize").value), saturation: Number($("rasterSaturation").value), opacity: Number($("rasterOpacity").value) };
  }
  async function selectedModel(config) {
    if (config.localModelSource === "imported") {
      const record = globalThis.EdaLocalOnnx.listImportedModels().find((item) => item.id === config.importedModel);
      if (!record?.manifest) throw new Error("\u8BF7\u5BFC\u5165\u5E76\u9009\u62E9\u5B8C\u6574\u6A21\u578B\u76EE\u5F55\uFF1B\u65E7\u5BFC\u5165\u8BB0\u5F55\u9700\u8981\u91CD\u65B0\u5BFC\u5165");
      return record.manifest;
    }
    return globalThis.EdaLocalOnnx.resolveRemoteModel(config.localModelPreset, config.customModelUrl, config.modelMirror, state.controller?.signal);
  }
  function bindSettings() {
    $("artworkStyle").onchange = () => syncSettings(currentConfig(), $);
    $("circuitRandomBtn").onclick = () => {
      $("circuitSeed").value = crypto.getRandomValues(new Uint32Array(1))[0];
    };
    for (const id of ["localModelSource", "localModelPreset", "mirrorPreset", "customModelUrl", "modelMirror", "importedModel", "cloudModelSource"]) $(id).addEventListener("change", () => {
      syncSettings(currentConfig(), $);
      refreshModelStatus().catch((e) => {
        $("modelStatus").textContent = e.message;
      });
    });
  }
  async function generateCloudImage() {
    if (!state.scene) return;
    const config = currentConfig();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    const timer = setTimeout(() => state.controller?.abort(new DOMException("\u56FE\u50CF\u751F\u6210\u8D85\u65F6", "TimeoutError")), Math.max(10, config.timeout) * 1e3);
    $("generateBtn").disabled = true;
    $("cancelBtn").disabled = false;
    status("\u4E91\u7AEF\u56FE\u50CF\u751F\u6210\u4E2D\uFF0C\u4FDD\u7559\u4E0A\u4E00\u7248\u9884\u89C8\u2026");
    try {
      const result = await requestCloudImage(config, $("themePrompt").value, signal);
      if (signal.aborted) throw signal.reason;
      const output = createManufacturingMask(state.scene, 512, false), process = processingOptions();
      const processedDataUrl = globalThis.EdaLocalOnnx.processLocalRaster(result.rgba, output.mask, process);
      pushHistory();
      state.raster = { kind: "raster", title: "Cloud Image Artwork", ...result, rawRgba: result.rgba, processedDataUrl, mask: output.mask, mapping: output.mapping, avoidKeepouts: false, backend: "cloud", steps: 0, seed: 0, processing: process, model: { id: config.imageModel, revision: "cloud", source: "cloud-image" } };
      state.spec = null;
      state.selected = null;
      $("reprocessBtn").disabled = false;
      $("applyBtn").disabled = false;
      render();
      status("\u4E91\u7AEF\u56FE\u50CF\u751F\u6210\u5B8C\u6210");
    } catch (e) {
      status(`\u4E91\u7AEF\u56FE\u50CF\u751F\u6210\u5931\u8D25\u6216\u5DF2\u53D6\u6D88\uFF1A${e.message}\uFF1B\u4E0A\u4E00\u4F5C\u54C1\u5DF2\u4FDD\u7559`);
    } finally {
      clearTimeout(timer);
      state.controller = null;
      $("generateBtn").disabled = false;
      $("cancelBtn").disabled = true;
    }
  }
  function localPrompt(text) {
    const pairs = [["\u6D77\u6D0B\u751F\u7269", "ocean life"], ["\u8760\u9CBC", "manta ray"], ["\u9B54\u9B3C\u9C7C", "manta ray"], ["\u9CB8\u9C7C", "whale"], ["\u9CA8\u9C7C", "shark"], ["\u7AE0\u9C7C", "octopus"], ["\u6C34\u6BCD", "jellyfish"], ["\u673A\u5668\u4EBA", "robot"], ["\u5B87\u822A\u5458", "astronaut"], ["\u732B", "cat"], ["\u9F99", "dragon"], ["\u82B1", "flowers"], ["\u6D41\u7EBF", "flowing ribbons"], ["\u661F\u7A7A", "starry sky"], ["\u8D5B\u535A\u670B\u514B", "cyberpunk"], ["\u7EA2\u8272", "red"], ["\u84DD\u8272", "blue"], ["\u7EFF\u8272", "green"], ["\u9EC4\u8272", "yellow"], ["\u7D2B\u8272", "purple"], ["\u6A59\u8272", "orange"]];
    let translated = text;
    for (const [source, target] of pairs) translated = translated.replaceAll(source, ` ${target} `);
    translated = translated.replace(/\b(?:PCB|printed circuit board|circuit board|silkscreen)\b/gi, " ");
    const hasChinese = /[\u3400-\u9fff]/u.test(translated);
    return { text: `${translated}. one large coherent subject made of broad continuous filled color regions, smooth bold contours, full-canvas flat poster illustration, background entirely solid black, 3 to 6 vivid solid colors, no text, no background texture`, hasUnsupportedChinese: hasChinese };
  }
  function progressText(p) {
    if (p.phase === "generate") return `\u672C\u5730\u53BB\u566A ${p.current}/${p.totalSteps}`;
    if (p.file && p.total) {
      const percent = Math.min(100, Math.round((p.loaded || 0) / p.total * 100));
      $("modelProgress").value = percent / 100;
      const speed = p.speed ? ` \xB7 ${formatBytes(p.speed)}/s` : "";
      const files = p.totalFiles ? `[${p.index}/${p.totalFiles}] ` : "";
      return `${files}${p.file} \xB7 ${percent}%${speed}`;
    }
    return p.message || p.phase;
  }
  function localSource(config) {
    if (config.localModelSource === "imported") {
      if (!config.importedModel) throw new Error("\u8BF7\u5148\u5BFC\u5165\u5E76\u9009\u62E9\u5B8C\u6574\u6A21\u578B\u76EE\u5F55");
      return { type: "imported", modelId: config.importedModel };
    }
    return { type: "remote", mirror: config.modelMirror || DEFAULT_CONFIG.modelMirror, manifest: config.resolvedManifest };
  }
  async function ensureLocalModel(config) {
    if (config.localModelSource === "imported") {
      config.resolvedManifest = await selectedModel(config);
      return;
    }
    config.resolvedManifest = await selectedModel(config);
    const cached = await globalThis.EdaLocalOnnx.defaultModelStatus(config.resolvedManifest);
    if (cached.complete) return;
    status("\u6B63\u5728\u4E0B\u8F7D\u5E76\u6821\u9A8C\u6A21\u578B\uFF0C\u53EF\u968F\u65F6\u53D6\u6D88\u2026");
    state.localBusy = true;
    await globalThis.EdaLocalOnnx.downloadDefaultModel(config.modelMirror, (p) => {
      $("modelStatus").textContent = progressText(p);
    }, config.resolvedManifest);
    await refreshModelStatus();
  }
  async function generateLocalArtwork() {
    if (!state.scene) return;
    if (!globalThis.EdaLocalOnnx) throw new Error("\u672C\u5730\u63A8\u7406\u6A21\u5757\u672A\u52A0\u8F7D");
    const config = currentConfig();
    if (currentArtwork()) pushHistory();
    $("generateBtn").disabled = true;
    $("cancelBtn").disabled = false;
    state.localBusy = true;
    state.controller = new AbortController();
    try {
      await ensureLocalModel(config);
      state.controller.signal.throwIfAborted();
      config.avoidKeepouts = config.avoidKeepouts && globalThis.EdaLocalOnnx.isInpainting(config.resolvedManifest);
      const constraintPkg = createManufacturingMask(state.scene, 512, config.avoidKeepouts);
      const outputPkg = createManufacturingMask(state.scene, 512, false);
      state.manufacturingMask = outputPkg;
      const prompt = localPrompt($("themePrompt").value);
      status(prompt.hasUnsupportedChinese ? "\u6B63\u5728\u672C\u5730\u751F\u6210\uFF1B\u672C\u5730\u6A21\u578B\u4E0D\u7406\u89E3\u7684\u4E2D\u6587\u8BCD\u53EF\u80FD\u88AB\u5FFD\u7565\uFF0C\u5EFA\u8BAE\u6539\u7528\u82F1\u6587\u2026" : "\u6B63\u5728\u672C\u5730\u751F\u6210\uFF1BPCB \u6570\u636E\u4E0D\u4F1A\u79BB\u5F00\u8BBE\u5907\u2026");
      const result = await globalThis.EdaLocalOnnx.generateLocal({ prompt: prompt.text, negativePrompt: "text, letters, typography, thin parallel lines, vertical stripes, barcode, hatching, crosshatch, grid, checkerboard, mosaic, tiled pattern, repeating texture, scanlines, glitch, noise, malformed, blurry", seed: config.localSeed, steps: config.localSteps, guidance: config.localGuidance, backend: config.localBackend, avoidKeepouts: config.avoidKeepouts, source: localSource(config), mask: constraintPkg.mask, onProgress: (p) => status(progressText(p)) });
      const process = processingOptions();
      const processedDataUrl = globalThis.EdaLocalOnnx.processLocalRaster(result.rgba, outputPkg.mask, process);
      state.raster = { kind: "raster", title: "Local ONNX Artwork", rawDataUrl: result.rawDataUrl, processedDataUrl, rawRgba: result.rgba, mask: outputPkg.mask, mapping: outputPkg.mapping, avoidKeepouts: config.avoidKeepouts, seed: result.seed, steps: result.steps, backend: result.backend, unetKernelLayout: result.unetKernelLayout, vaeBackend: result.vaeBackend, vaeDecodeMode: result.vaeDecodeMode, imageLayout: result.imageLayout, declaredImageLayout: result.declaredImageLayout, scheduler: result.scheduler, conditioningDelta: result.conditioningDelta, differingTokenCount: result.differingTokenCount, latentSafeRatio: result.latentSafeRatio, constraintMode: result.constraintMode, processing: process, model: { id: config.localModelSource === "imported" ? config.importedModel : config.resolvedManifest.id, revision: config.localModelSource === "imported" ? "imported" : config.resolvedManifest.revision, source: config.localModelSource } };
      state.spec = null;
      localStorage.setItem("easyedaColor.recentArtwork.v1", JSON.stringify({ kind: "raster", seed: result.seed, steps: result.steps, backend: result.backend, model: state.raster.model, createdAt: (/* @__PURE__ */ new Date()).toISOString() }));
      $("reprocessBtn").disabled = false;
      $("applyBtn").disabled = false;
      render();
      status(`\u672C\u5730\u751F\u6210\u5B8C\u6210\uFF1A${result.backend} \xB7 ${result.steps} \u6B65 \xB7 seed ${result.seed}`);
    } catch (e) {
      status(e.name === "AbortError" ? `\u672C\u5730\u751F\u6210\u5DF2\u53D6\u6D88\uFF0C\u4E0A\u4E00\u6709\u6548\u7248\u672C\u5DF2\u4FDD\u7559` : `\u672C\u5730\u751F\u6210\u5931\u8D25\uFF1A${e.message}\u3002\u53EF\u5207\u6362\u4E91\u7AEF\u6A21\u578B\uFF0C\u4E0A\u4E00\u4F5C\u54C1\u672A\u4E22\u5931\u3002`);
    } finally {
      state.controller = null;
      state.localBusy = false;
      $("generateBtn").disabled = false;
      $("cancelBtn").disabled = true;
    }
  }
  function reprocessRaster() {
    if (!state.raster) return;
    pushHistory();
    const process = processingOptions();
    state.raster.processedDataUrl = globalThis.EdaLocalOnnx.processLocalRaster(state.raster.rawRgba, state.raster.mask, process);
    state.raster.processing = process;
    render();
    status("\u5DF2\u91CD\u65B0\u5904\u7406\u5E76\u518D\u6B21\u5E94\u7528\u5236\u9020\u8499\u7248");
  }
  async function generateCircuit() {
    if (!state.scene) return;
    $("generateBtn").disabled = true;
    status("\u6B63\u5728\u6309\u5668\u4EF6\u5E03\u5C40\u89C4\u5212\u5F69\u8679\u88C5\u9970\u8D70\u7EBF\u2026");
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const c = currentConfig(), ctx = document.createElement("canvas").getContext("2d"), board = new Path2D(state.scene.boardPath);
      const spec = generateCircuitArtwork(state.scene, {
        seed: c.circuitSeed,
        density: c.circuitDensity,
        lineWidth: c.circuitLineWidth,
        clearance: c.circuitClearance,
        isInside: (x, y, r) => [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]].every(([dx, dy]) => ctx.isPointInPath(board, x + dx, y + dy, "evenodd"))
      });
      pushHistory();
      state.spec = spec;
      state.raster = null;
      state.selected = null;
      $("applyBtn").disabled = false;
      $("reprocessBtn").disabled = true;
      render();
      status(`\u5F69\u8679\u7535\u8DEF\u5B8C\u6210\uFF1A${spec.routeCount} \u6761\u88C5\u9970\u8D70\u7EBF \xB7 seed ${spec.seed} \xB7 \u5DF2\u6309 SVG BBOX \u7ED5\u884C`);
    } catch (e) {
      status(`\u5F69\u8679\u7535\u8DEF\u751F\u6210\u5931\u8D25\uFF1A${e.message}\uFF1B\u4E0A\u4E00\u4F5C\u54C1\u4FDD\u7559`);
    } finally {
      $("generateBtn").disabled = false;
    }
  }
  async function generate() {
    if (currentConfig().artworkStyle === "rainbow-circuit") return generateCircuit();
    return currentConfig().engine === "local" ? generateLocalArtwork() : currentConfig().cloudModelSource === "image" ? generateCloudImage() : generateCloud();
  }
  function cancelGeneration() {
    state.controller?.abort();
    if (state.localBusy) {
      globalThis.EdaLocalOnnx?.cancelLocal();
      status("\u6B63\u5728\u53D6\u6D88\u672C\u5730\u64CD\u4F5C\u2026");
    }
  }
  async function renderArtworkPng() {
    const svg = createSvg(state.scene, currentArtwork(), { transparent: true, showComponents: false, showKeepouts: false, rasterView: "processed" });
    let size = 1800, data;
    do {
      data = await svgToDataUrl(svg, "image/png", size);
      size = Math.floor(size * 0.72);
    } while (Math.ceil((data.length - data.indexOf(",") - 1) * 0.75) > 2 * 1024 * 1024 && size > 500);
    if (Math.ceil((data.length - data.indexOf(",") - 1) * 0.75) > 2 * 1024 * 1024) throw new Error("PNG \u65E0\u6CD5\u538B\u7F29\u5230 2 MiB \u5185");
    return data;
  }
  async function applyToPcb() {
    if (!currentArtwork()) return;
    try {
      status("\u6B63\u5728\u6E32\u67D3\u5E76\u5199\u56DE\u9876\u5C42\u5F69\u8272\u4E1D\u5370\u2026");
      const data = await renderArtworkPng();
      const saved = eda.sys_Storage.getExtensionUserConfig(RESULT_KEY);
      const old = typeof saved === "string" ? JSON.parse(saved) : saved;
      const b = state.scene.sourceBounds;
      const placement = easyEdaImagePlacement(b);
      const filename = `ai-color-silkscreen-${Date.now()}.png`;
      const obj = await eda.pcb_PrimitiveObject.create(getLayer("TOP_SILKSCREEN"), placement.x, placement.y, data, placement.width, placement.height, 0, false, filename, true);
      if (!obj) throw new Error("EasyEDA \u672A\u521B\u5EFA PrimitiveObject");
      const artworkCacheId = state.raster ? crypto.randomUUID() : void 0;
      if (state.raster) await globalThis.EdaLocalOnnx.saveArtworkImages(artworkCacheId, state.raster.rawDataUrl, state.raster.processedDataUrl);
      state.lastAppliedId = obj.getState_PrimitiveId();
      const artwork = state.raster ? { kind: "raster", cacheId: artworkCacheId, seed: state.raster.seed, steps: state.raster.steps, backend: state.raster.backend, processing: state.raster.processing, model: state.raster.model, mapping: state.raster.mapping } : state.spec;
      const editableSvg = state.spec ? new XMLSerializer().serializeToString(createSvg(state.scene, state.spec, { transparent: true, showComponents: false, showKeepouts: false })) : void 0;
      await eda.sys_Storage.setExtensionUserConfig(RESULT_KEY, { primitiveId: state.lastAppliedId, filename, type: state.raster ? "raster" : "vector", artworkCacheId, svg: editableSvg, artwork, scene: compactScene(state.scene), parameters: { engine: currentConfig().engine, model: state.raster?.model || currentConfig().model, theme: $("themePrompt").value, createdAt: (/* @__PURE__ */ new Date()).toISOString() } });
      if (old?.primitiveId) {
        const own = await eda.pcb_PrimitiveObject.get(old.primitiveId).catch(() => void 0);
        if (own) await eda.pcb_PrimitiveObject.delete(old.primitiveId);
      }
      if (old?.artworkCacheId) await globalThis.EdaLocalOnnx.deleteArtworkImages(old.artworkCacheId);
      $("undoApplyBtn").disabled = false;
      status(`\u5DF2\u5199\u56DE\u5E76\u9501\u5B9A\uFF1A${filename}`);
    } catch (e) {
      status(`\u5199\u56DE\u5931\u8D25\uFF1A${e.message}`);
    }
  }
  async function undoApply() {
    const saved = eda.sys_Storage.getExtensionUserConfig(RESULT_KEY);
    const own = typeof saved === "string" ? JSON.parse(saved) : saved;
    if (!own?.primitiveId) {
      status("\u6CA1\u6709\u672C\u6269\u5C55\u5199\u5165\u7684\u5BF9\u8C61");
      return;
    }
    const exists = await eda.pcb_PrimitiveObject.get(own.primitiveId).catch(() => void 0);
    if (exists) await eda.pcb_PrimitiveObject.delete(own.primitiveId);
    if (own.artworkCacheId) await globalThis.EdaLocalOnnx?.deleteArtworkImages(own.artworkCacheId);
    await eda.sys_Storage.deleteExtensionUserConfig(RESULT_KEY);
    state.lastAppliedId = null;
    $("undoApplyBtn").disabled = true;
    status("\u5DF2\u64A4\u9500\u672C\u6269\u5C55\u6700\u8FD1\u4E00\u6B21\u5199\u56DE\uFF1B\u672A\u89E6\u78B0\u7528\u6237\u539F\u6709\u4E1D\u5370");
  }
  function fit() {
    if (!state.scene) return;
    state.view = { x: 0, y: 0, w: state.scene.viewBox.width, h: state.scene.viewBox.height };
    render();
  }
  function zoom(factor) {
    const v = state.view, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    v.w *= factor;
    v.h *= factor;
    v.x = cx - v.w / 2;
    v.y = cy - v.h / 2;
    render();
  }
  function bindPan() {
    let start;
    const stage = $("stage");
    stage.onpointerdown = (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, v: { ...state.view } };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    };
    stage.onpointermove = (e) => {
      if (!start || !state.scene) return;
      const r = stage.getBoundingClientRect();
      state.view.x = start.v.x - (e.clientX - start.x) * start.v.w / r.width;
      state.view.y = start.v.y - (e.clientY - start.y) * start.v.h / r.height;
      render();
    };
    stage.onpointerup = () => {
      start = null;
      stage.classList.remove("dragging");
    };
    stage.onwheel = (e) => {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.12 : 0.89);
    };
  }
  function formatBytes(value) {
    return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  async function refreshImportedModels() {
    const records = globalThis.EdaLocalOnnx?.listImportedModels?.() || [];
    const selected = $("importedModel").value || currentConfig().importedModel;
    $("importedModel").replaceChildren(...records.map((record) => {
      const option = document.createElement("option");
      option.value = record.id;
      option.textContent = `${record.name} \xB7 ${formatBytes(record.size)}`;
      return option;
    }));
    if (records.some((r) => r.id === selected)) $("importedModel").value = selected;
    if (!records.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "\u5C1A\u672A\u5BFC\u5165";
      $("importedModel").append(option);
    }
  }
  var modelStatusRevision = 0;
  async function refreshModelStatus() {
    if (!globalThis.EdaLocalOnnx) return;
    const revision = ++modelStatusRevision;
    const config = currentConfig();
    if (config.localModelSource === "imported") {
      const record = globalThis.EdaLocalOnnx.listImportedModels().find((r) => r.id === config.importedModel);
      $("modelProgress").value = record ? 1 : 0;
      $("modelStatus").textContent = record ? `\u672C\u5730\u6A21\u578B\uFF1A${record.name} \xB7 ${formatBytes(record.size)}` : "\u8BF7\u9009\u62E9\u672C\u5730\u6A21\u578B\u76EE\u5F55";
      return;
    }
    if (config.localModelPreset === "custom") {
      $("modelProgress").value = 0;
      $("modelStatus").textContent = "\u70B9\u51FB\u4E0B\u8F7D/\u6821\u9A8C\uFF0C\u89E3\u6790\u81EA\u5B9A\u4E49\u6A21\u578B\u94FE\u63A5\u5E76\u68C0\u67E5\u7F13\u5B58";
      return;
    }
    const manifest = await selectedModel(config);
    const value = await globalThis.EdaLocalOnnx.defaultModelStatus(manifest);
    if (revision !== modelStatusRevision) return;
    $("modelProgress").value = value.total ? value.cached / value.total : 0;
    $("modelStatus").textContent = `${manifest.displayName} \xB7 ${value.complete ? "\u5DF2\u7F13\u5B58" : "\u5DF2\u7F13\u5B58 " + formatBytes(value.cached) + " /"} ${formatBytes(value.total)}`;
  }
  async function downloadModel() {
    const config = currentConfig();
    state.controller = new AbortController();
    $("downloadModelBtn").disabled = true;
    $("cancelBtn").disabled = false;
    state.localBusy = true;
    try {
      config.resolvedManifest = await selectedModel(config);
      state.controller.signal.throwIfAborted();
      await globalThis.EdaLocalOnnx.downloadDefaultModel(config.modelMirror, (p) => {
        $("modelStatus").textContent = progressText(p);
      }, config.resolvedManifest);
      await refreshModelStatus();
      status("\u6A21\u578B\u4E0B\u8F7D\u548C SHA-256 \u6821\u9A8C\u5B8C\u6210\uFF0C\u53EF\u79BB\u7EBF\u751F\u6210");
    } catch (e) {
      status(`\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\u6216\u5DF2\u53D6\u6D88\uFF1A${e.message}`);
    } finally {
      state.controller = null;
      state.localBusy = false;
      $("downloadModelBtn").disabled = false;
      $("cancelBtn").disabled = true;
    }
  }
  async function importModel(event) {
    const files = event.target.files;
    if (!files?.length) return;
    $("modelProgress").value = 0;
    status("\u6B63\u5728\u5BFC\u5165\u5E76\u6821\u9A8C\u6A21\u578B\u76EE\u5F55\u2026");
    try {
      const record = await globalThis.EdaLocalOnnx.importModelFolder(files, (p) => {
        $("modelStatus").textContent = progressText(p);
      });
      await refreshImportedModels();
      $("importedModel").value = record.id;
      $("localModelSource").value = "imported";
      syncSettings(currentConfig(), $);
      status(`\u5DF2\u5BFC\u5165 ${record.name}\uFF08${formatBytes(record.size)}\uFF09`);
    } catch (e) {
      status(`\u5BFC\u5165\u5931\u8D25\uFF1A${e.message}`);
    } finally {
      event.target.value = "";
    }
  }
  async function deleteModel() {
    const id = $("importedModel").value;
    if (!id) {
      status("\u6CA1\u6709\u53EF\u5220\u9664\u7684\u5BFC\u5165\u6A21\u578B");
      return;
    }
    await globalThis.EdaLocalOnnx.deleteImportedModel(id);
    await refreshImportedModels();
    status("\u5DF2\u5220\u9664\u6240\u9009\u5BFC\u5165\u6A21\u578B\u53CA\u5176\u4E13\u7528\u7F13\u5B58");
  }
  async function init() {
    const loaded = await loadConfig();
    await refreshImportedModels();
    if (loaded.importedModel) $("importedModel").value = loaded.importedModel;
    await refreshModelStatus().catch((e) => {
      $("modelStatus").textContent = `\u7F13\u5B58\u68C0\u67E5\u5931\u8D25\uFF1A${e.message}`;
    });
    bindPan();
    bindSettings();
    $("scanBtn").onclick = () => scan(false);
    $("demoBtn").onclick = () => scan(true);
    $("saveConfigBtn").onclick = () => saveConfig().catch((e) => status(e.message));
    $("generateBtn").onclick = generate;
    $("cancelBtn").onclick = cancelGeneration;
    $("applyBtn").onclick = applyToPcb;
    $("undoApplyBtn").onclick = undoApply;
    $("localEngineBtn").onclick = () => setEngine("local");
    $("cloudEngineBtn").onclick = () => setEngine("cloud");
    $("downloadModelBtn").onclick = downloadModel;
    $("importModelInput").onchange = importModel;
    $("deleteModelBtn").onclick = () => deleteModel().catch((e) => status(`\u5220\u9664\u5931\u8D25\uFF1A${e.message}`));
    $("randomSeedBtn").onclick = () => {
      $("localSeed").value = crypto.getRandomValues(new Uint32Array(1))[0];
    };
    $("reprocessBtn").onclick = reprocessRaster;
    $("rasterView").onchange = render;
    ["showComponents", "showKeepouts", "showOriginal", "showConflicts"].forEach((id) => $(id).onchange = render);
    $("pathFill").oninput = (e) => editSelected((p) => p.fill = e.target.value);
    $("pathStroke").oninput = (e) => editSelected((p) => p.stroke = e.target.value);
    $("pathOpacity").oninput = (e) => editSelected((p) => p.opacity = Number(e.target.value));
    $("deletePathBtn").onclick = () => {
      pushHistory();
      state.spec.paths = state.spec.paths.filter((p) => p.id !== state.selected);
      state.selected = null;
      render();
    };
    try {
      const saved = eda?.sys_Storage?.getExtensionUserConfig(RESULT_KEY);
      const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
      $("undoApplyBtn").disabled = !parsed?.primitiveId;
    } catch {
    }
    await scan(false);
    try {
      const recent = JSON.parse(localStorage.getItem("easyedaColor.recentArtwork.v1") || "null");
      if (recent) $("diagnostics").textContent += `

\u6700\u8FD1\u4F5C\u54C1\u5143\u6570\u636E\uFF1A${recent.backend} \xB7 ${recent.steps} \u6B65 \xB7 seed ${recent.seed}`;
    } catch {
    }
  }
  var editTimer;
  function editSelected(change) {
    const p = state.spec?.paths.find((x) => x.id === state.selected);
    if (!p) return;
    if (!editTimer) {
      pushHistory();
      editTimer = setTimeout(() => editTimer = null, 400);
    }
    change(p);
    render();
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") window.addEventListener("DOMContentLoaded", () => init().catch((e) => status(`\u521D\u59CB\u5316\u5931\u8D25\uFF1A${e.message}`)));
})();
