import { SETTINGS_DEFAULTS, loadExtraSettings, readExtraSettings, mirrorAddress, syncSettings } from './settings.mjs';
import { requestCloudImage } from './cloud-image.mjs';
import { generateCircuitArtwork, circuitPathHits } from './circuit-art.mjs';
import { componentRegion, pointsBounds, regionPoints } from './regions.mjs';
const SVG_NS = 'http://www.w3.org/2000/svg';
const CONFIG_KEY = 'easyedaColor.config.v1';
const RESULT_KEY = 'easyedaColor.result.v1';
const DEFAULT_CONFIG = Object.freeze({
  ...SETTINGS_DEFAULTS,
  engine: 'local', modelMirror: 'https://huggingface.co', localModelSource: 'remote', importedModel: '',
  localBackend: 'auto', avoidKeepouts: true, localSeed: 0, localSteps: 10, localGuidance: 7,
  backgroundThreshold: 24, paletteSize: 6, rasterSaturation: 1.15, rasterOpacity: 1,
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
  model: 'deepseek/deepseek-v4-flash-vision-exp',
  apiKey: '', temperature: 0.5, timeout: 60, autoRepair: true,
});

export const ARTWORK_SCHEMA = {
  name: 'easyeda_artwork_spec', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['version', 'title', 'background', 'palette', 'paths'],
    properties: {
      version: { const: 1 }, title: { type: 'string', maxLength: 80 },
      background: { type: 'string' },
      palette: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
      paths: { type: 'array', minItems: 1, maxItems: 40, items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'role', 'd', 'fill', 'stroke', 'strokeWidth', 'opacity'],
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
          role: { enum: ['hero', 'flow', 'accent'] }, d: { type: 'string', maxLength: 12000 },
          fill: { type: 'string' }, stroke: { type: 'string' },
          strokeWidth: { type: 'number', minimum: 0, maximum: 80 },
          opacity: { type: 'number', minimum: 0, maximum: 1 },
        },
      } },
    },
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const PATH_CHARS = /^[0-9eE+.,\-\sMLCQAZ]+$/;

export function sanitizePathData(value) {
  if (typeof value !== 'string' || value.length > 12000 || !PATH_CHARS.test(value)) throw new Error('Path 含不允许的字符或命令');
  const d = value.trim().replace(/\s+/g, ' ');
  if (!/^M(?:\s|[-+0-9.])/.test(d) || !/[Z]$/.test(d)) throw new Error('Path 必须以绝对 M 开始并以 Z 闭合');
  const commands = d.match(/[A-Za-z]/g) || [];
  if (commands.some(c => !'MLCQAZ'.includes(c))) throw new Error('仅允许绝对 M/L/C/Q/A/Z 命令');
  return d;
}

function color(value, fallback = 'none') {
  return value === 'none' || HEX.test(value || '') ? value : fallback;
}

export function validateArtworkSpec(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.paths) || !raw.paths.length) throw new Error('模型返回的 ArtworkSpec 无效');
  const ids = new Set();
  const paths = raw.paths.slice(0, 40).map((p, index) => {
    const id = String(p.id || `path-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    if (!id || ids.has(id)) throw new Error(`路径 ID 重复或无效: ${id}`);
    ids.add(id);
    if (!['hero', 'flow', 'accent'].includes(p.role)) throw new Error(`路径角色无效: ${id}`);
    return { id, role: p.role, d: sanitizePathData(p.d), fill: color(p.fill, '#ffffff'), stroke: color(p.stroke),
      strokeWidth: Math.max(0, Math.min(80, Number(p.strokeWidth) || 0)), opacity: Math.max(0, Math.min(1, Number(p.opacity ?? 1))) };
  });
  return { version: 1, title: String(raw.title || 'AI Artwork').slice(0, 80), background: color(raw.background, '#14202b'),
    palette: (Array.isArray(raw.palette) ? raw.palette : []).map(v => color(v, '#ffffff')).slice(0, 8), paths };
}

export function boxesIntersect(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function inflateBox(b, amount) {
  return { ...b, minX: b.minX - amount, minY: b.minY - amount, maxX: b.maxX + amount, maxY: b.maxY + amount };
}

export function normalizeScene(raw) {
  const b = raw.boardBounds;
  const width = Math.max(1, b.maxX - b.minX); const height = Math.max(1, b.maxY - b.minY);
  // Preserve the PCB's physical aspect ratio. Clamping viewHeight used to apply
  // a different X/Y scale to unusually wide or tall boards, which made both
  // component positions and sizes look wrong in the preview.
  const viewWidth = 1000; const viewHeight = 1000 * height / width;
  const sx = viewWidth / width; const sy = sx;
  // EasyEDA PCB coordinates grow upward, while SVG Y grows downward.
  const point = (x, y) => ({ x: (x - b.minX) * sx, y: (b.maxY - y) * sy });
  const box = o => {
    if(o.points?.length){const points=o.points.map(p=>point(p.x,p.y));return {...o,...pointsBounds(points),points,rotation:o.rotation};}
    const p1 = point(o.minX, o.minY); const p2 = point(o.maxX, o.maxY); return { ...o, minX:Math.min(p1.x,p2.x),minY:Math.min(p1.y,p2.y),maxX:Math.max(p1.x,p2.x),maxY:Math.max(p1.y,p2.y) };
  };
  const segments = (raw.outlineSegments || []).map(s => ({ ...s, a:point(s.a.x,s.a.y), b:point(s.b.x,s.b.y), angle:s.angle===undefined?undefined:-s.angle, radius:s.radius ? s.radius * sx : undefined }));
  const components=(raw.components || []).map(box); const keepouts=(raw.keepouts || raw.components || []).map(box);
  // The final artwork mask must match the visible SVG keepout set exactly.
  const manufacturingKeepouts=keepouts;
  return { version:1, units:'normalized-svg', viewBox:{width:viewWidth,height:viewHeight}, boardBounds:{minX:0,minY:0,maxX:viewWidth,maxY:viewHeight},
    sourceBounds:b, boardPath: stitchOutline(segments, viewWidth, viewHeight), components, keepouts, manufacturingKeepouts,
    anchors:findAnchors(keepouts, viewWidth, viewHeight), transform:{sx,sy,originX:b.minX,originY:b.maxY,flipY:true} };
}

export function easyEdaImagePlacement(sourceBounds) {
  return {x:sourceBounds.minX,y:sourceBounds.maxY,width:sourceBounds.maxX-sourceBounds.minX,height:sourceBounds.maxY-sourceBounds.minY};
}

export function rgbaPixelsToMask(pixels,pixelCount) {
  if(pixels.length!==pixelCount*4)throw new Error('Canvas RGBA 数据长度不匹配');
  const mask=new Uint8Array(pixelCount);
  for(let i=0;i<pixelCount;i++)mask[i]=pixels[i*4]>127?255:0;
  return mask;
}

function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
export function stitchOutline(segments, width, height) {
  if (!segments.length) return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`;
  const remaining = [...segments]; const contours = [];
  while (remaining.length) {
    let seg = remaining.shift(); const start = seg.a; let current = seg.b;
    let d = `M ${fmt(start.x)} ${fmt(start.y)} ${segmentCommand(seg, false)}`;
    while (remaining.length && dist(current, start) > 1.5) {
      let best=-1, reverse=false, score=Infinity;
      remaining.forEach((candidate,i) => { const da=dist(current,candidate.a), db=dist(current,candidate.b); if(da<score){best=i;reverse=false;score=da;} if(db<score){best=i;reverse=true;score=db;} });
      if (score > 3) break;
      seg=remaining.splice(best,1)[0]; d += ` ${segmentCommand(seg, reverse)}`; current=reverse?seg.a:seg.b;
    }
    contours.push(`${d} Z`);
  }
  return contours.join(' ');
}

export function closedPointSegments(points) {
  const clean=(points||[]).filter(p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y));
  if(clean.length<3)return [];
  return clean.map((point,index)=>({kind:'line',a:point,b:clean[(index+1)%clean.length]}));
}

export function polygonSourceOutline(source) {
  if(!Array.isArray(source)||source[0]!=='R'||source.length<7)return {segments:[],bounds:undefined};
  const [x,y,width,height,rotation,rawRadius]=source.slice(1).map(Number);
  if(![x,y,width,height,rotation,rawRadius].every(Number.isFinite)||width<=0||height<=0)return {segments:[],bounds:undefined};
  const radius=Math.max(0,Math.min(rawRadius,width/2,height/2)),angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const point=(dx,dy)=>({x:x+dx*c-dy*s,y:y+dx*s+dy*c});
  const corners=[point(0,0),point(width,0),point(width,-height),point(0,-height)];
  if(radius===0)return {segments:closedPointSegments(corners),bounds:pointsBounds(corners)};
  const points=[point(radius,0),point(width-radius,0),point(width,-radius),point(width,-height+radius),point(width-radius,-height),point(radius,-height),point(0,-height+radius),point(0,-radius)];
  const segments=[];
  for(let index=0;index<points.length;index++)segments.push({kind:index%2?'arc':'line',a:points[index],b:points[(index+1)%points.length],angle:index%2?-90:undefined,radius:index%2?radius:undefined});
  return {segments,bounds:pointsBounds(corners)};
}

function segmentCommand(s, reverse) {
  const end = reverse ? s.a : s.b;
  if (s.kind !== 'arc') return `L ${fmt(end.x)} ${fmt(end.y)}`;
  const angle = (Number(s.angle) || 0) * (reverse ? -1 : 1);
  return `A ${fmt(Math.abs(s.radius || 1))} ${fmt(Math.abs(s.radius || 1))} 0 ${Math.abs(angle)>180?1:0} ${angle>=0?1:0} ${fmt(end.x)} ${fmt(end.y)}`;
}
function fmt(n) { return Number(n.toFixed(3)); }

export function findAnchors(keepouts, width, height) {
  const candidates = [
    {name:'center',x:.5*width,y:.5*height},{name:'upper-left',x:.24*width,y:.25*height},{name:'upper-right',x:.76*width,y:.25*height},
    {name:'lower-left',x:.24*width,y:.75*height},{name:'lower-right',x:.76*width,y:.75*height},
  ];
  return candidates.map(a => ({...a, clearance:keepouts.reduce((m,b)=>Math.min(m, Math.hypot(a.x-(b.minX+b.maxX)/2,a.y-(b.minY+b.maxY)/2)),Infinity)})).sort((a,b)=>b.clearance-a.clearance).slice(0,3);
}

function getLayer(name) {
  const value = globalThis.EPCB_LayerId?.[name];
  if (value === undefined) throw new Error(`EasyEDA 未提供 EPCB_LayerId.${name}，请升级专业版客户端`);
  return value;
}

function componentCategory(designator, name) {
  const s=`${designator} ${name}`.toUpperCase();
  if (/USB|TYPE.?C|CONN|J\d/.test(s)) return 'connector'; if (/LED|D\d/.test(s)) return 'led';
  if (/MCU|ESP|STM|RP\d|U\d/.test(s)) return 'ic'; if (/SW|KEY|BTN/.test(s)) return 'button'; if (/H\d|HOLE|SCREW|MOUNT/.test(s)) return 'mounting-hole'; return 'component';
}

export function chooseComponentBox(fullBox, pinBox, category) {
  if(!pinBox || category==='connector' || category==='mounting-hole') return inflateBox(fullBox,8);
  const width=Math.max(1,pinBox.maxX-pinBox.minX),height=Math.max(1,pinBox.maxY-pinBox.minY);const margin=Math.max(8,Math.min(40,Math.max(width,height)*.06));
  return inflateBox(pinBox,margin);
}

export { componentRegion };

export async function readEasyEdaScene() {
  if (!globalThis.eda) throw new Error('仅能在 EasyEDA Pro 扩展 iframe 中读取 PCB');
  const outlineLayer=getLayer('BOARD_OUTLINE');
  const readPolylines=async()=>{try{return await eda.pcb_PrimitivePolyline?.getAll?.(undefined,outlineLayer)||[];}catch{return [];}};
  const [lines,arcs,polylines,components]=await Promise.all([
    eda.pcb_PrimitiveLine.getAll(undefined,outlineLayer), eda.pcb_PrimitiveArc.getAll(undefined,outlineLayer),
    readPolylines(),
    eda.pcb_PrimitiveComponent.getAll(),
  ]);
  const outline=[...lines,...arcs,...polylines];
  const outlineBox=outline.length ? await eda.pcb_Primitive.getPrimitivesBBox(outline) : undefined;
  const compBoxes=[];
  for (const comp of components) {
    const designator=String(comp.getState_Designator?.() || ''); const name=String(comp.getState_Name?.() || comp.getState_Component?.()?.name || '');
    const category=componentCategory(designator,name);const id=comp.getState_PrimitiveId();const b=await eda.pcb_Primitive.getPrimitivesBBox([comp]).catch(()=>undefined);if(!b)continue;
    const pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id).catch(()=>undefined);const pinBox=pins?.length?await eda.pcb_Primitive.getPrimitivesBBox(pins).catch(()=>undefined):undefined;
    const base=chooseComponentBox(b,pinBox,category),pinPoints=(pins||[]).map(p=>({x:Number(p.getState_X?.()),y:Number(p.getState_Y?.())})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
    const region=componentRegion(base,pinPoints,category,{x:Number(comp.getState_X?.()),y:Number(comp.getState_Y?.())},Number(comp.getState_Rotation?.())||0);
    compBoxes.push({...region,id,designator,name,category,type:'component'});
  }
  const polylineOutlines=polylines.map(p=>{try{return polygonSourceOutline(p.getState_Polygon().getSource());}catch{return {segments:[],bounds:undefined};}});
  const exactPolylineBounds=polylineOutlines.map(o=>o.bounds).filter(Boolean);
  let boardBounds=!lines.length&&!arcs.length&&exactPolylineBounds.length?{minX:Math.min(...exactPolylineBounds.map(b=>b.minX)),minY:Math.min(...exactPolylineBounds.map(b=>b.minY)),maxX:Math.max(...exactPolylineBounds.map(b=>b.maxX)),maxY:Math.max(...exactPolylineBounds.map(b=>b.maxY))}:outlineBox;
  if(!boardBounds) {
    const all=[...compBoxes]; if(!all.length) throw new Error('当前 PCB 没有可识别的板框或器件');
    boardBounds=inflateBox({minX:Math.min(...all.map(x=>x.minX)),minY:Math.min(...all.map(x=>x.minY)),maxX:Math.max(...all.map(x=>x.maxX)),maxY:Math.max(...all.map(x=>x.maxY))},100);
  }
  const outlineSegments=[...lines.map(l=>({kind:'line',a:{x:l.getState_StartX(),y:l.getState_StartY()},b:{x:l.getState_EndX(),y:l.getState_EndY()}})),
    ...arcs.map(a=>{const p={x:a.getState_StartX(),y:a.getState_StartY()};const q={x:a.getState_EndX(),y:a.getState_EndY()};const angle=a.getState_ArcAngle();const radius=dist(p,q)/(2*Math.max(.001,Math.abs(Math.sin(angle*Math.PI/360))));return {kind:'arc',a:p,b:q,angle,radius};})];
  polylineOutlines.forEach(outline=>outlineSegments.push(...outline.segments));
  return normalizeScene({boardBounds,outlineSegments,components:compBoxes,keepouts:compBoxes});
}

export function demoScene() {
  const raw={boardBounds:{minX:0,minY:0,maxX:1600,maxY:900},outlineSegments:[
    {kind:'line',a:{x:0,y:80},b:{x:80,y:0}},{kind:'line',a:{x:80,y:0},b:{x:1520,y:0}},{kind:'line',a:{x:1520,y:0},b:{x:1600,y:80}},
    {kind:'line',a:{x:1600,y:80},b:{x:1600,y:820}},{kind:'line',a:{x:1600,y:820},b:{x:1520,y:900}},{kind:'line',a:{x:1520,y:900},b:{x:80,y:900}},
    {kind:'line',a:{x:80,y:900},b:{x:0,y:820}},{kind:'line',a:{x:0,y:820},b:{x:0,y:80}}],components:[
      {id:'U1',designator:'U1',name:'ESP32-S3',category:'ic',type:'component',minX:620,minY:280,maxX:980,maxY:620},
      {id:'J1',designator:'J1',name:'USB-C',category:'connector',type:'component',minX:0,minY:330,maxX:230,maxY:570},
      {id:'D1',designator:'D1',name:'RGB LED',category:'led',type:'component',minX:1260,minY:160,maxX:1400,maxY:300},
      {id:'SW1',designator:'SW1',name:'BOOT',category:'button',type:'component',minX:1240,minY:650,maxX:1440,maxY:810}],keepouts:[]};
  raw.keepouts=[...raw.components,{id:'H1',type:'mounting-hole',minX:90,minY:80,maxX:190,maxY:180},{id:'H2',type:'mounting-hole',minX:1410,minY:720,maxX:1510,maxY:820}];
  return normalizeScene(raw);
}

function compactScene(scene) {
  return {version:1,coordinateSystem:`0 0 ${scene.viewBox.width} ${scene.viewBox.height}`,boardPath:scene.boardPath,
    keepouts:scene.keepouts.map(({id,type,designator,name,category,minX,minY,maxX,maxY,points,rotation})=>({id,type,designator,name,category,minX:fmt(minX),minY:fmt(minY),maxX:fmt(maxX),maxY:fmt(maxY),rotation,points:points?.map(p=>({x:fmt(p.x),y:fmt(p.y)}))})),anchors:scene.anchors.map(a=>({...a,x:fmt(a.x),y:fmt(a.y),clearance:fmt(a.clearance)}))};
}

function promptFor(scene, theme, repair) {
  const repairText=repair ? `\n这是唯一一次修复。冲突清单：${JSON.stringify(repair)}。移动或重绘这些路径，保持主体辨识度。` : '';
  return `你是 PCB 彩色丝印设计师。根据图片和精确 JSON 只返回符合 schema 的 ArtworkSpec。主题：${theme}\n`+
    `坐标必须处于 viewBox。建立三层层级：1 个清晰主体 hero、1–3 个宽闭合 flow、3–8 个大小不同且不规则分布的 accent。主体必须是可辨识的闭合填充轮廓；流线是宽闭合色带，不能靠细 stroke；不要重复网格。`+
    `任何图案不得穿过红色器件禁区或板外。焊盘和过孔不出现在场景 SVG 中，最终由本地制造蒙版强制裁剪。优先使用 JSON 中 clearance 最大的 anchors。所有 d 只能用绝对 M/L/C/Q/A/Z 并以 Z 闭合。stroke 不用时写 none。`+
    `Few-shot: 蝠鲼主体可用“M 250 350 C 330 260 430 260 500 350 C 430 330 390 410 375 470 C 350 420 330 350 250 350 Z”；流线可用“M 80 650 C 300 520 650 560 900 430 L 900 470 C 650 610 300 570 80 690 Z”。反例：穿过器件、等距圆点阵列、开放主体轮廓。${repairText}\n精确场景 JSON：${JSON.stringify(compactScene(scene))}`;
}

async function svgToDataUrl(svg, mime='image/png', maxPixels=1400) {
  const xml=new XMLSerializer().serializeToString(svg); const blob=new Blob([xml],{type:'image/svg+xml'}); const url=URL.createObjectURL(blob);
  try { const img=new Image(); await new Promise((ok,fail)=>{img.onload=ok;img.onerror=fail;img.src=url;});
    const vb=svg.viewBox.baseVal; const scale=Math.min(maxPixels/vb.width,maxPixels/vb.height); const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(vb.width*scale)); canvas.height=Math.max(1,Math.round(vb.height*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height); return canvas.toDataURL(mime);
  } finally { URL.revokeObjectURL(url); }
}

async function callModel(config, scene, sceneImage, theme, signal, repair) {
  const body={model:config.model,temperature:Number(config.temperature),max_tokens:5000,reasoning:{effort:'none',exclude:true},
    response_format:{type:'json_schema',json_schema:ARTWORK_SCHEMA},messages:[{role:'user',content:[{type:'text',text:promptFor(scene,theme,repair)},{type:'image_url',image_url:{url:sceneImage}}]}]};
  const response=await fetch(config.apiUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`,'HTTP-Referer':'https://pro.easyeda.com','X-Title':'EasyEDA Color Silkscreen'},body:JSON.stringify(body),signal});
  if(!response.ok) { let detail=''; try{detail=(await response.json())?.error?.message || '';}catch{} throw new Error(`API ${response.status}: ${detail || response.statusText}`); }
  const json=await response.json(); const content=json?.choices?.[0]?.message?.content;
  if(!content) throw new Error('模型没有返回内容');
  return validateArtworkSpec(typeof content==='string'?JSON.parse(content):content);
}

function el(name,attrs={},textValue) { const n=document.createElementNS(SVG_NS,name); Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,String(v))); if(textValue!==undefined)n.textContent=textValue; return n; }

function pathBBox(d) {
  const svg=el('svg'); svg.style.position='absolute';svg.style.visibility='hidden'; const p=el('path',{d});svg.append(p);document.body.append(svg);
  try { const b=p.getBBox(); return {minX:b.x,minY:b.y,maxX:b.x+b.width,maxY:b.y+b.height}; } finally { svg.remove(); }
}

export function conflictReport(spec, scene) {
  if(spec.style==='rainbow-circuit')return spec.paths.map(p=>({id:p.id,role:p.role,bbox:pathBBox(p.d),hits:circuitPathHits(p,spec,scene).map(k=>k.id),ratio:0}));
  return spec.paths.map(p=>{const b=pathBBox(p.d);const hits=scene.keepouts.filter(k=>boxesIntersect(b,k)); const area=Math.max(1,(b.maxX-b.minX)*(b.maxY-b.minY)); const overlap=hits.reduce((sum,k)=>{const w=Math.max(0,Math.min(b.maxX,k.maxX)-Math.max(b.minX,k.minX));const h=Math.max(0,Math.min(b.maxY,k.maxY)-Math.max(b.minY,k.minY));return sum+w*h;},0);return {id:p.id,role:p.role,bbox:b,hits:hits.map(h=>h.id),ratio:Math.min(1,overlap/area)};});
}

function createSvg(scene,spec,options={}) {
  const {width,height}=scene.viewBox; const svg=el('svg',{viewBox:`0 0 ${width} ${height}`,'data-kind':'easyeda-color-artwork'});
  const defs=el('defs'); const mask=el('mask',{id:'manufacturing-mask',maskUnits:'userSpaceOnUse',x:0,y:0,width,height});
  mask.append(el('path',{d:scene.boardPath,fill:'white',stroke:'black','stroke-width':Math.max(4,width*.012),'fill-rule':'evenodd'}));
  const regionElement=(region,attrs={})=>region.points?.length?el('polygon',{points:regionPoints(region).map(p=>`${p.x},${p.y}`).join(' '),...attrs}):el('rect',{x:region.minX,y:region.minY,width:region.maxX-region.minX,height:region.maxY-region.minY,rx:Math.min(8,(region.maxX-region.minX)/4),...attrs});
  const activeKeepouts=spec?.kind==='raster'?[]:scene.keepouts;activeKeepouts.forEach(k=>mask.append(regionElement(k,{fill:'black'}))); defs.append(mask); svg.append(defs);
  svg.append(el('path',{d:scene.boardPath,fill:options.transparent?'none':(spec?.background||'#14202b'),stroke:options.transparent?'none':'#4c6378','stroke-width':2,'fill-rule':'evenodd'}));
  const original=el('g',{class:'original-art','data-layer':'original'}); const clipped=el('g',{mask:'url(#manufacturing-mask)','data-layer':'artwork'});
  if(spec?.printBackground)clipped.append(el('path',{d:scene.boardPath,fill:spec.background,'fill-rule':'evenodd'}));
  if(spec?.kind==='raster') {
    const m=spec.mapping; const href=options.rasterView==='raw'?spec.rawDataUrl:spec.processedDataUrl;
    const attrs={href,x:-m.offsetX*width/m.drawWidth,y:-m.offsetY*height/m.drawHeight,width:512*width/m.drawWidth,height:512*height/m.drawHeight,preserveAspectRatio:'none'};
    original.append(el('image',{...attrs,href:spec.rawDataUrl})); clipped.append(el('image',attrs));
  } else (spec?.paths||[]).forEach(p=>{const attrs={d:p.d,fill:p.fill,stroke:p.stroke,'stroke-width':p.strokeWidth,opacity:p.opacity,'data-id':p.id,class:'art-path','fill-rule':'evenodd'};original.append(el('path',attrs));clipped.append(el('path',attrs));});
  original.style.display=options.showOriginal?'':'none';svg.append(original,clipped);
  const comps=el('g',{'data-layer':'components'});scene.components.forEach(c=>{comps.append(regionElement(c,{class:'component'}));comps.append(el('text',{x:c.minX+4,y:c.minY+14,fill:'#cbd5e1','font-size':11},`${c.designator||''} ${c.category||''}`));}); comps.style.display=options.showComponents===false?'none':'';svg.append(comps);
  const keeps=el('g',{'data-layer':'keepouts'});scene.keepouts.forEach(k=>keeps.append(regionElement(k,{class:'keepout'}))); keeps.style.display=options.showKeepouts===false?'none':'';svg.append(keeps);
  return svg;
}

function deepCopy(v){return JSON.parse(JSON.stringify(v));}
const state={scene:null,spec:null,raster:null,history:[],selected:null,controller:null,localBusy:false,manufacturingMask:null,view:{x:0,y:0,w:1000,h:600},lastAppliedId:null};
const $=id=>document.getElementById(id);

async function loadConfig(){let saved={};try{saved=globalThis.eda?.sys_Storage?.getExtensionUserConfig(CONFIG_KEY)||{};if(typeof saved==='string')saved=JSON.parse(saved);}catch{}const c={...DEFAULT_CONFIG,...saved};
  ['apiUrl','model','apiKey','temperature','timeout','modelMirror','localModelSource','importedModel','localBackend','localSeed','localSteps','localGuidance','backgroundThreshold','paletteSize','rasterSaturation','rasterOpacity'].forEach(k=>{if($(k))$(k).value=c[k];});$('avoidKeepouts').checked=c.avoidKeepouts===true;$('autoRepair').checked=c.autoRepair!==false;loadExtraSettings(saved,$);setEngine(c.engine==='cloud'?'cloud':'local');syncSettings(currentConfig(),$);return c;}
function currentConfig(){return {...readExtraSettings($),engine:$('localEngineBtn').classList.contains('active')?'local':'cloud',modelMirror:mirrorAddress($('mirrorPreset').value,$('modelMirror').value),localModelSource:$('localModelSource').value,importedModel:$('importedModel').value,localBackend:$('localBackend').value,avoidKeepouts:!$('avoidKeepouts').disabled&&$('avoidKeepouts').checked,localSeed:Number($('localSeed').value)>>>0,localSteps:Number($('localSteps').value),localGuidance:Number($('localGuidance').value),backgroundThreshold:Number($('backgroundThreshold').value),paletteSize:Number($('paletteSize').value),rasterSaturation:Number($('rasterSaturation').value),rasterOpacity:Number($('rasterOpacity').value),apiUrl:$('apiUrl').value.trim(),model:$('model').value.trim(),apiKey:$('apiKey').value.trim(),temperature:Number($('temperature').value),timeout:Number($('timeout').value),autoRepair:$('autoRepair').checked};}
async function saveConfig(){const c=currentConfig();if(c.artworkStyle!=='rainbow-circuit'&&c.engine==='cloud'&&(c.cloudModelSource==='image'?(!c.imageApiUrl||!c.imageModel):(!c.apiUrl||!c.model)))throw new Error('API URL 和模型不能为空');await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY,c);status('配置已保存');}
function status(text){$('status').textContent=text;}
function options(){return {showOriginal:$('showOriginal').checked,showComponents:$('showComponents').checked,showKeepouts:$('showKeepouts').checked,rasterView:$('rasterView').value};}
function currentArtwork(){return state.raster||state.spec;}
function setEngine(engine){const local=engine==='local';$('localEngineBtn').classList.toggle('active',local);$('cloudEngineBtn').classList.toggle('active',!local);$('localSettings').hidden=!local;$('cloudSettings').hidden=local;$('rasterViewLabel').hidden=!state.raster;$('pathEditor').hidden=true;syncSettings(currentConfig(),$);if(state.scene)render();}

function render(){if(!state.scene)return;$('rasterViewLabel').hidden=!state.raster;const artwork=currentArtwork();const svg=createSvg(state.scene,artwork,options());svg.setAttribute('viewBox',`${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);$('stage').replaceChildren(svg);$('emptyState').style.display='none';
  svg.querySelectorAll('.art-path').forEach(p=>p.addEventListener('click',e=>{e.stopPropagation();selectPath(p.dataset.id);}));
  if(state.spec){const report=conflictReport(state.spec,state.scene);if($('showConflicts').checked){const g=el('g',{'data-layer':'conflicts'});report.filter(r=>r.hits.length).forEach(r=>g.append(el('rect',{x:r.bbox.minX,y:r.bbox.minY,width:r.bbox.maxX-r.bbox.minX,height:r.bbox.maxY-r.bbox.minY,class:'conflict'})));svg.append(g);}renderPathList(report);$('diagnostics').textContent=diagnosticText(report);}
  else if(state.raster){$('pathList').replaceChildren();$('pathEditor').hidden=true;const layout=state.raster.imageLayout?`\nUNet 内核 ${state.raster.unetKernelLayout||'unknown'} · VAE ${state.raster.vaeBackend||'unknown'} · ${state.raster.vaeDecodeMode||'unknown'} · 输出 ${state.raster.declaredImageLayout||'unknown'} → ${state.raster.imageLayout}`:'';const scheduler=state.raster.scheduler?`\n调度器 ${state.raster.scheduler}`:'';const conditioning=state.raster.conditioningDelta!==undefined?`\n提示词条件差 ${state.raster.conditioningDelta.toFixed(5)} · ${state.raster.differingTokenCount} 个差异 token`:'';const constraint=state.raster.constraintMode?`\n约束 ${state.raster.constraintMode} · latent 开放率 ${Math.round((state.raster.latentSafeRatio??1)*100)}%`:'';const avoidance=state.raster.backend==='cloud'?'云端图像按提示词生成，未输入 BBOX 蒙版':state.raster.avoidKeepouts?`已将 SVG 的 ${state.scene.keepouts.length} 个器件框作为 Inpainting 背景条件输入；请检查原图中的保留效果`:'未启用 BBOX 留白';$('diagnostics').textContent=`${state.raster.backend==='cloud'?'云端图像':'本地 ONNX'} 栅格作品\n模型 ${state.raster.model.id}\nrevision ${state.raster.model.revision}\n后端 ${state.raster.backend} · ${state.raster.steps} 步 · seed ${state.raster.seed}${layout}${scheduler}${conditioning}${constraint}\n\n${avoidance}；焊盘和过孔不参与约束。`;}
  else {$('pathList').replaceChildren();$('diagnostics').textContent='尚未生成';}
  $('sceneStats').textContent=`板面 ${Math.round(state.scene.sourceBounds.maxX-state.scene.sourceBounds.minX)} × ${Math.round(state.scene.sourceBounds.maxY-state.scene.sourceBounds.minY)} mil\n器件框 ${state.scene.components.length}\n有效禁区 ${state.scene.keepouts.length}（仅 SVG 可见区域）\n锚点 ${state.scene.anchors.map(a=>a.name).join('、')}`;
}
function diagnosticText(report){const hit=report.filter(r=>r.hits.length);return hit.length?`${hit.length} 条路径与原始 BBOX 相交。\n${hit.map(r=>`${r.id}: ${r.hits.join(', ')} (${Math.round(r.ratio*100)}%)`).join('\n')}\n\n最终 PNG 已强制应用制造蒙版。`:'未检测到 BBOX 冲突；最终仍会应用制造蒙版。';}
function renderPathList(report){$('pathList').replaceChildren(...state.spec.paths.map(p=>{const r=report.find(x=>x.id===p.id);const n=document.createElement('div');const swatch=document.createElement('i');const name=document.createElement('span');const badge=document.createElement('small');n.className=`path-item${state.selected===p.id?' selected':''}`;swatch.className='swatch';badge.className='badge';swatch.style.background=p.fill==='none'?p.stroke:p.fill;name.textContent=p.id;badge.textContent=`${p.role}${r?.hits.length?' · 冲突':''}`;n.append(swatch,name,badge);n.onclick=()=>selectPath(p.id);return n;}));}
function selectPath(id){state.selected=id;const p=state.spec?.paths.find(x=>x.id===id);$('pathEditor').hidden=!p;if(p){const item=conflictReport(state.spec,state.scene).find(r=>r.id===id);$('pathTitle').textContent=p.id;$('pathFill').value=p.fill==='none'?'#ffffff':p.fill;$('pathStroke').value=p.stroke==='none'?'#000000':p.stroke;$('pathOpacity').value=p.opacity;$('pathMeta').textContent=`角色 ${p.role}；${item?.hits.length?`冲突 ${item.hits.join('、')}`:'无 BBOX 冲突'}`;}render();}
function cloneArtwork(){return state.raster?{type:'raster',value:{...state.raster,rawRgba:new Uint8ClampedArray(state.raster.rawRgba),mask:new Uint8Array(state.raster.mask)}}:state.spec?{type:'vector',value:deepCopy(state.spec)}:null;}
function pushHistory(){const item=cloneArtwork();if(item){state.history.push(item);if(state.history.length>20)state.history.shift();}}

async function scan(useDemo=false){try{status('正在读取 PCB…');state.scene=useDemo?demoScene():await readEasyEdaScene();state.spec=null;state.raster=null;state.manufacturingMask=createManufacturingMask(state.scene);state.selected=null;fit();render();$('generateBtn').disabled=false;status(useDemo?'已加载内置演示板':'PCB 场景已读取');}catch(e){status(`读取失败：${e.message}`);if(!useDemo)$('emptyState').style.display='flex';}}

export function createManufacturingMask(scene,size=512,avoidKeepouts=true){const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d',{willReadFrequently:true});const scale=Math.min(size/scene.viewBox.width,size/scene.viewBox.height);const drawWidth=scene.viewBox.width*scale,drawHeight=scene.viewBox.height*scale,offsetX=(size-drawWidth)/2,offsetY=(size-drawHeight)/2;
  ctx.fillStyle='#000';ctx.fillRect(0,0,size,size);ctx.save();ctx.translate(offsetX,offsetY);ctx.scale(scale,scale);ctx.fillStyle='#fff';ctx.strokeStyle='#000';ctx.lineWidth=Math.max(4,scene.viewBox.width*.012);const board=new Path2D(scene.boardPath);ctx.fill(board,'evenodd');ctx.stroke(board);ctx.fillStyle='#000';(avoidKeepouts?scene.keepouts:[]).forEach(k=>{const points=regionPoints(k);ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fill();});ctx.restore();const pixels=ctx.getImageData(0,0,size,size).data;const mask=rgbaPixelsToMask(pixels,size*size);return {mask,mapping:{offsetX,offsetY,drawWidth,drawHeight,scale}};}

async function sceneImage(withArtwork=false){const svg=createSvg(state.scene,withArtwork?state.spec:null,{showComponents:true,showKeepouts:true,transparent:false});if(withArtwork&&state.spec){const report=conflictReport(state.spec,state.scene);const g=el('g',{'data-layer':'repair-conflicts'});report.filter(r=>r.hits.length).forEach(r=>g.append(el('rect',{x:r.bbox.minX,y:r.bbox.minY,width:r.bbox.maxX-r.bbox.minX,height:r.bbox.maxY-r.bbox.minY,fill:'#ff000088',stroke:'#ff0000','stroke-width':5})));svg.append(g);}return svgToDataUrl(svg,'image/png',1200);}

async function generateCloud(){if(!state.scene)return;const config=currentConfig();if(!config.apiKey){status('请先填写 API Key');$('apiKey').focus();return;}if(currentArtwork())pushHistory();state.controller=new AbortController();const timer=setTimeout(()=>state.controller.abort(new DOMException('60 秒超时','TimeoutError')),Math.max(10,config.timeout)*1000);$('generateBtn').disabled=true;$('cancelBtn').disabled=false;status('模型正在生成，保留上一版预览…');
  try{const image=await sceneImage(false);let spec=await callModel(config,state.scene,image,$('themePrompt').value,state.controller.signal);state.spec=spec;state.raster=null;render();let report=conflictReport(spec,state.scene);const severe=report.filter(r=>r.role==='hero'&&r.ratio>.16||r.ratio>.32);
    if(config.autoRepair&&severe.length){status(`主体冲突较重，正在执行唯一一次视觉修复…`);const repairImage=await sceneImage(true);spec=await callModel(config,state.scene,repairImage,$('themePrompt').value,state.controller.signal,severe.map(r=>({pathId:r.id,hitIds:r.hits,suggestedDirection:suggestDirection(r.bbox,state.scene)})));state.spec=spec;state.raster=null;render();report=conflictReport(spec,state.scene);}
    $('applyBtn').disabled=false;status(`生成完成：${spec.paths.length} 条路径，${report.filter(r=>r.hits.length).length} 条经制造蒙版裁剪`);
  }catch(e){if(e.name==='AbortError'||e.name==='TimeoutError')status('生成已取消或超时，上一有效版本已保留');else status(`生成失败：${e.message}`);}finally{clearTimeout(timer);state.controller=null;$('generateBtn').disabled=false;$('cancelBtn').disabled=true;}}
function suggestDirection(b,scene){const cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2;return `${cx<scene.viewBox.width/2?'right':'left'}-${cy<scene.viewBox.height/2?'down':'up'}`;}

function processingOptions(){return {backgroundThreshold:Number($('backgroundThreshold').value),paletteSize:Number($('paletteSize').value),saturation:Number($('rasterSaturation').value),opacity:Number($('rasterOpacity').value)};}

async function selectedModel(config) {
  if(config.localModelSource==='imported') {
    const record=globalThis.EdaLocalOnnx.listImportedModels().find(item=>item.id===config.importedModel);
    if(!record?.manifest)throw new Error('请导入并选择完整模型目录；旧导入记录需要重新导入');
    return record.manifest;
  }
  return globalThis.EdaLocalOnnx.resolveRemoteModel(config.localModelPreset,config.customModelUrl,config.modelMirror,state.controller?.signal);
}

function bindSettings(){
  $('artworkStyle').onchange=()=>syncSettings(currentConfig(),$);
  $('circuitRandomBtn').onclick=()=>{$('circuitSeed').value=crypto.getRandomValues(new Uint32Array(1))[0];};
  for(const id of ['localModelSource','localModelPreset','mirrorPreset','customModelUrl','modelMirror','importedModel','cloudModelSource'])$(id).addEventListener('change',()=>{
    syncSettings(currentConfig(),$);refreshModelStatus().catch(e=>{$('modelStatus').textContent=e.message;});
  });
}

async function generateCloudImage() {
  if(!state.scene)return;
  const config=currentConfig();state.controller=new AbortController();
  const signal=state.controller.signal;
  const timer=setTimeout(()=>state.controller?.abort(new DOMException('图像生成超时','TimeoutError')),Math.max(10,config.timeout)*1000);
  $('generateBtn').disabled=true;$('cancelBtn').disabled=false;status('云端图像生成中，保留上一版预览…');
  try {
    const result=await requestCloudImage(config,$('themePrompt').value,signal);
    if(signal.aborted)throw signal.reason;
    const output=createManufacturingMask(state.scene,512,false),process=processingOptions();
    const processedDataUrl=globalThis.EdaLocalOnnx.processLocalRaster(result.rgba,output.mask,process);
    pushHistory();
    state.raster={kind:'raster',title:'Cloud Image Artwork',...result,rawRgba:result.rgba,processedDataUrl,mask:output.mask,mapping:output.mapping,avoidKeepouts:false,backend:'cloud',steps:0,seed:0,processing:process,model:{id:config.imageModel,revision:'cloud',source:'cloud-image'}};
    state.spec=null;state.selected=null;$('reprocessBtn').disabled=false;$('applyBtn').disabled=false;render();status('云端图像生成完成');
  } catch(e) { status(`云端图像生成失败或已取消：${e.message}；上一作品已保留`); }
  finally { clearTimeout(timer);state.controller=null;$('generateBtn').disabled=false;$('cancelBtn').disabled=true; }
}
function localPrompt(text){const pairs=[['海洋生物','ocean life'],['蝠鲼','manta ray'],['魔鬼鱼','manta ray'],['鲸鱼','whale'],['鲨鱼','shark'],['章鱼','octopus'],['水母','jellyfish'],['机器人','robot'],['宇航员','astronaut'],['猫','cat'],['龙','dragon'],['花','flowers'],['流线','flowing ribbons'],['星空','starry sky'],['赛博朋克','cyberpunk'],['红色','red'],['蓝色','blue'],['绿色','green'],['黄色','yellow'],['紫色','purple'],['橙色','orange']];let translated=text;for(const [source,target] of pairs)translated=translated.replaceAll(source,` ${target} `);translated=translated.replace(/\b(?:PCB|printed circuit board|circuit board|silkscreen)\b/gi,' ');const hasChinese=/[\u3400-\u9fff]/u.test(translated);return {text:`${translated}. one large coherent subject made of broad continuous filled color regions, smooth bold contours, full-canvas flat poster illustration, background entirely solid black, 3 to 6 vivid solid colors, no text, no background texture`,hasUnsupportedChinese:hasChinese};}
function progressText(p){if(p.phase==='generate')return `本地去噪 ${p.current}/${p.totalSteps}`;if(p.file&&p.total){const percent=Math.min(100,Math.round((p.loaded||0)/p.total*100));$('modelProgress').value=percent/100;const speed=p.speed?` · ${formatBytes(p.speed)}/s`:'';const files=p.totalFiles?`[${p.index}/${p.totalFiles}] `:'';return `${files}${p.file} · ${percent}%${speed}`;}return p.message||p.phase;}
function localSource(config){if(config.localModelSource==='imported'){if(!config.importedModel)throw new Error('请先导入并选择完整模型目录');return {type:'imported',modelId:config.importedModel};}return {type:'remote',mirror:config.modelMirror||DEFAULT_CONFIG.modelMirror,manifest:config.resolvedManifest};}
async function ensureLocalModel(config){if(config.localModelSource==='imported'){config.resolvedManifest=await selectedModel(config);return;}config.resolvedManifest=await selectedModel(config);const cached=await globalThis.EdaLocalOnnx.defaultModelStatus(config.resolvedManifest);if(cached.complete)return;status('正在下载并校验模型，可随时取消…');state.localBusy=true;await globalThis.EdaLocalOnnx.downloadDefaultModel(config.modelMirror,p=>{$('modelStatus').textContent=progressText(p);},config.resolvedManifest);await refreshModelStatus();}
async function generateLocalArtwork(){
  if(!state.scene)return;if(!globalThis.EdaLocalOnnx)throw new Error('本地推理模块未加载');const config=currentConfig();if(currentArtwork())pushHistory();$('generateBtn').disabled=true;$('cancelBtn').disabled=false;state.localBusy=true;state.controller=new AbortController();
  try{
    await ensureLocalModel(config);state.controller.signal.throwIfAborted();config.avoidKeepouts=config.avoidKeepouts&&globalThis.EdaLocalOnnx.isInpainting(config.resolvedManifest);const constraintPkg=createManufacturingMask(state.scene,512,config.avoidKeepouts);const outputPkg=createManufacturingMask(state.scene,512,false);state.manufacturingMask=outputPkg;const prompt=localPrompt($('themePrompt').value);
    status(prompt.hasUnsupportedChinese?'正在本地生成；本地模型不理解的中文词可能被忽略，建议改用英文…':'正在本地生成；PCB 数据不会离开设备…');

    const result=await globalThis.EdaLocalOnnx.generateLocal({prompt:prompt.text,negativePrompt:'text, letters, typography, thin parallel lines, vertical stripes, barcode, hatching, crosshatch, grid, checkerboard, mosaic, tiled pattern, repeating texture, scanlines, glitch, noise, malformed, blurry',seed:config.localSeed,steps:config.localSteps,guidance:config.localGuidance,backend:config.localBackend,avoidKeepouts:config.avoidKeepouts,source:localSource(config),mask:constraintPkg.mask,onProgress:p=>status(progressText(p))});
    const process=processingOptions();const processedDataUrl=globalThis.EdaLocalOnnx.processLocalRaster(result.rgba,outputPkg.mask,process);
    state.raster={kind:'raster',title:'Local ONNX Artwork',rawDataUrl:result.rawDataUrl,processedDataUrl,rawRgba:result.rgba,mask:outputPkg.mask,mapping:outputPkg.mapping,avoidKeepouts:config.avoidKeepouts,seed:result.seed,steps:result.steps,backend:result.backend,unetKernelLayout:result.unetKernelLayout,vaeBackend:result.vaeBackend,vaeDecodeMode:result.vaeDecodeMode,imageLayout:result.imageLayout,declaredImageLayout:result.declaredImageLayout,scheduler:result.scheduler,conditioningDelta:result.conditioningDelta,differingTokenCount:result.differingTokenCount,latentSafeRatio:result.latentSafeRatio,constraintMode:result.constraintMode,processing:process,model:{id:config.localModelSource==='imported'?config.importedModel:config.resolvedManifest.id,revision:config.localModelSource==='imported'?'imported':config.resolvedManifest.revision,source:config.localModelSource}};
    state.spec=null;localStorage.setItem('easyedaColor.recentArtwork.v1',JSON.stringify({kind:'raster',seed:result.seed,steps:result.steps,backend:result.backend,model:state.raster.model,createdAt:new Date().toISOString()}));$('reprocessBtn').disabled=false;$('applyBtn').disabled=false;render();status(`本地生成完成：${result.backend} · ${result.steps} 步 · seed ${result.seed}`);
  }catch(e){status(e.name==='AbortError'?`本地生成已取消，上一有效版本已保留`:`本地生成失败：${e.message}。可切换云端模型，上一作品未丢失。`);}finally{state.controller=null;state.localBusy=false;$('generateBtn').disabled=false;$('cancelBtn').disabled=true;}
}
function reprocessRaster(){if(!state.raster)return;pushHistory();const process=processingOptions();state.raster.processedDataUrl=globalThis.EdaLocalOnnx.processLocalRaster(state.raster.rawRgba,state.raster.mask,process);state.raster.processing=process;render();status('已重新处理并再次应用制造蒙版');}
async function generateCircuit(){
  if(!state.scene)return;
  $('generateBtn').disabled=true;status('正在按器件布局规划彩虹装饰走线…');
  await new Promise(resolve=>setTimeout(resolve,30));
  try {
    const c=currentConfig(), ctx=document.createElement('canvas').getContext('2d'),board=new Path2D(state.scene.boardPath);
    const spec=generateCircuitArtwork(state.scene,{seed:c.circuitSeed,density:c.circuitDensity,lineWidth:c.circuitLineWidth,clearance:c.circuitClearance,
      isInside:(x,y,r)=>[[0,0],[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,r],[r,-r],[-r,-r]].every(([dx,dy])=>ctx.isPointInPath(board,x+dx,y+dy,'evenodd'))});
    pushHistory();state.spec=spec;state.raster=null;state.selected=null;$('applyBtn').disabled=false;$('reprocessBtn').disabled=true;render();
    status(`彩虹电路完成：${spec.routeCount} 条装饰走线 · seed ${spec.seed} · 已按 SVG BBOX 绕行`);
  }catch(e){status(`彩虹电路生成失败：${e.message}；上一作品保留`);}finally{$('generateBtn').disabled=false;}
}
async function generate(){if(currentConfig().artworkStyle==='rainbow-circuit')return generateCircuit();return currentConfig().engine==='local'?generateLocalArtwork():currentConfig().cloudModelSource==='image'?generateCloudImage():generateCloud();}
function cancelGeneration(){state.controller?.abort();if(state.localBusy){globalThis.EdaLocalOnnx?.cancelLocal();status('正在取消本地操作…');}}

async function renderArtworkPng(){const svg=createSvg(state.scene,currentArtwork(),{transparent:true,showComponents:false,showKeepouts:false,rasterView:'processed'});let size=1800,data;do{data=await svgToDataUrl(svg,'image/png',size);size=Math.floor(size*.72);}while(Math.ceil((data.length-data.indexOf(',')-1)*.75)>2*1024*1024&&size>500);if(Math.ceil((data.length-data.indexOf(',')-1)*.75)>2*1024*1024)throw new Error('PNG 无法压缩到 2 MiB 内');return data;}
async function applyToPcb(){if(!currentArtwork())return;try{status('正在渲染并写回顶层彩色丝印…');const data=await renderArtworkPng();const saved=eda.sys_Storage.getExtensionUserConfig(RESULT_KEY);const old=typeof saved==='string'?JSON.parse(saved):saved;
    const b=state.scene.sourceBounds;const placement=easyEdaImagePlacement(b);const filename=`ai-color-silkscreen-${Date.now()}.png`;const obj=await eda.pcb_PrimitiveObject.create(getLayer('TOP_SILKSCREEN'),placement.x,placement.y,data,placement.width,placement.height,0,false,filename,true);if(!obj)throw new Error('EasyEDA 未创建 PrimitiveObject');
    const artworkCacheId=state.raster?crypto.randomUUID():undefined;if(state.raster)await globalThis.EdaLocalOnnx.saveArtworkImages(artworkCacheId,state.raster.rawDataUrl,state.raster.processedDataUrl);state.lastAppliedId=obj.getState_PrimitiveId();const artwork=state.raster?{kind:'raster',cacheId:artworkCacheId,seed:state.raster.seed,steps:state.raster.steps,backend:state.raster.backend,processing:state.raster.processing,model:state.raster.model,mapping:state.raster.mapping}:state.spec;const editableSvg=state.spec?new XMLSerializer().serializeToString(createSvg(state.scene,state.spec,{transparent:true,showComponents:false,showKeepouts:false})):undefined;await eda.sys_Storage.setExtensionUserConfig(RESULT_KEY,{primitiveId:state.lastAppliedId,filename,type:state.raster?'raster':'vector',artworkCacheId,svg:editableSvg,artwork,scene:compactScene(state.scene),parameters:{engine:currentConfig().engine,model:state.raster?.model||currentConfig().model,theme:$('themePrompt').value,createdAt:new Date().toISOString()}});if(old?.primitiveId){const own=await eda.pcb_PrimitiveObject.get(old.primitiveId).catch(()=>undefined);if(own)await eda.pcb_PrimitiveObject.delete(old.primitiveId);}if(old?.artworkCacheId)await globalThis.EdaLocalOnnx.deleteArtworkImages(old.artworkCacheId);$('undoApplyBtn').disabled=false;status(`已写回并锁定：${filename}`);
  }catch(e){status(`写回失败：${e.message}`);}}
async function undoApply(){const saved=eda.sys_Storage.getExtensionUserConfig(RESULT_KEY);const own=typeof saved==='string'?JSON.parse(saved):saved;if(!own?.primitiveId){status('没有本扩展写入的对象');return;}const exists=await eda.pcb_PrimitiveObject.get(own.primitiveId).catch(()=>undefined);if(exists)await eda.pcb_PrimitiveObject.delete(own.primitiveId);if(own.artworkCacheId)await globalThis.EdaLocalOnnx?.deleteArtworkImages(own.artworkCacheId);await eda.sys_Storage.deleteExtensionUserConfig(RESULT_KEY);state.lastAppliedId=null;$('undoApplyBtn').disabled=true;status('已撤销本扩展最近一次写回；未触碰用户原有丝印');}

function fit(){if(!state.scene)return;state.view={x:0,y:0,w:state.scene.viewBox.width,h:state.scene.viewBox.height};render();}
function zoom(factor){const v=state.view,cx=v.x+v.w/2,cy=v.y+v.h/2;v.w*=factor;v.h*=factor;v.x=cx-v.w/2;v.y=cy-v.h/2;render();}
function bindPan(){let start;const stage=$('stage');stage.onpointerdown=e=>{if(e.button!==0)return;start={x:e.clientX,y:e.clientY,v:{...state.view}};stage.setPointerCapture(e.pointerId);stage.classList.add('dragging');};stage.onpointermove=e=>{if(!start||!state.scene)return;const r=stage.getBoundingClientRect();state.view.x=start.v.x-(e.clientX-start.x)*start.v.w/r.width;state.view.y=start.v.y-(e.clientY-start.y)*start.v.h/r.height;render();};stage.onpointerup=()=>{start=null;stage.classList.remove('dragging');};stage.onwheel=e=>{e.preventDefault();zoom(e.deltaY>0?1.12:.89);};}

function formatBytes(value){return value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:`${(value/1024**2).toFixed(1)} MB`;}
async function refreshImportedModels(){const records=globalThis.EdaLocalOnnx?.listImportedModels?.()||[];const selected=$('importedModel').value||currentConfig().importedModel;$('importedModel').replaceChildren(...records.map(record=>{const option=document.createElement('option');option.value=record.id;option.textContent=`${record.name} · ${formatBytes(record.size)}`;return option;}));if(records.some(r=>r.id===selected))$('importedModel').value=selected;if(!records.length){const option=document.createElement('option');option.value='';option.textContent='尚未导入';$('importedModel').append(option);}}
let modelStatusRevision=0;
async function refreshModelStatus(){if(!globalThis.EdaLocalOnnx)return;const revision=++modelStatusRevision;const config=currentConfig();if(config.localModelSource==='imported'){const record=globalThis.EdaLocalOnnx.listImportedModels().find(r=>r.id===config.importedModel);$('modelProgress').value=record?1:0;$('modelStatus').textContent=record?`本地模型：${record.name} · ${formatBytes(record.size)}`:'请选择本地模型目录';return;}if(config.localModelPreset==='custom'){$('modelProgress').value=0;$('modelStatus').textContent='点击下载/校验，解析自定义模型链接并检查缓存';return;}const manifest=await selectedModel(config);const value=await globalThis.EdaLocalOnnx.defaultModelStatus(manifest);if(revision!==modelStatusRevision)return;$('modelProgress').value=value.total?value.cached/value.total:0;$('modelStatus').textContent=`${manifest.displayName} · ${value.complete?'已缓存':'已缓存 '+formatBytes(value.cached)+' /'} ${formatBytes(value.total)}`;}
async function downloadModel(){const config=currentConfig();state.controller=new AbortController();$('downloadModelBtn').disabled=true;$('cancelBtn').disabled=false;state.localBusy=true;try{config.resolvedManifest=await selectedModel(config);state.controller.signal.throwIfAborted();await globalThis.EdaLocalOnnx.downloadDefaultModel(config.modelMirror,p=>{$('modelStatus').textContent=progressText(p);},config.resolvedManifest);await refreshModelStatus();status('模型下载和 SHA-256 校验完成，可离线生成');}catch(e){status(`模型下载失败或已取消：${e.message}`);}finally{state.controller=null;state.localBusy=false;$('downloadModelBtn').disabled=false;$('cancelBtn').disabled=true;}}
async function importModel(event){const files=event.target.files;if(!files?.length)return;$('modelProgress').value=0;status('正在导入并校验模型目录…');try{const record=await globalThis.EdaLocalOnnx.importModelFolder(files,p=>{$('modelStatus').textContent=progressText(p);});await refreshImportedModels();$('importedModel').value=record.id;$('localModelSource').value='imported';syncSettings(currentConfig(),$);status(`已导入 ${record.name}（${formatBytes(record.size)}）`);}catch(e){status(`导入失败：${e.message}`);}finally{event.target.value='';}}
async function deleteModel(){const id=$('importedModel').value;if(!id){status('没有可删除的导入模型');return;}await globalThis.EdaLocalOnnx.deleteImportedModel(id);await refreshImportedModels();status('已删除所选导入模型及其专用缓存');}

async function init(){const loaded=await loadConfig();await refreshImportedModels();if(loaded.importedModel)$('importedModel').value=loaded.importedModel;await refreshModelStatus().catch(e=>{$('modelStatus').textContent=`缓存检查失败：${e.message}`;});bindPan();bindSettings();$('scanBtn').onclick=()=>scan(false);$('demoBtn').onclick=()=>scan(true);$('saveConfigBtn').onclick=()=>saveConfig().catch(e=>status(e.message));$('generateBtn').onclick=generate;$('cancelBtn').onclick=cancelGeneration;$('applyBtn').onclick=applyToPcb;$('undoApplyBtn').onclick=undoApply;
  $('localEngineBtn').onclick=()=>setEngine('local');$('cloudEngineBtn').onclick=()=>setEngine('cloud');$('downloadModelBtn').onclick=downloadModel;$('importModelInput').onchange=importModel;$('deleteModelBtn').onclick=()=>deleteModel().catch(e=>status(`删除失败：${e.message}`));$('randomSeedBtn').onclick=()=>{$('localSeed').value=crypto.getRandomValues(new Uint32Array(1))[0];};$('reprocessBtn').onclick=reprocessRaster;$('rasterView').onchange=render;
  ['showComponents','showKeepouts','showOriginal','showConflicts'].forEach(id=>$(id).onchange=render);
  $('pathFill').oninput=e=>editSelected(p=>p.fill=e.target.value);$('pathStroke').oninput=e=>editSelected(p=>p.stroke=e.target.value);$('pathOpacity').oninput=e=>editSelected(p=>p.opacity=Number(e.target.value));$('deletePathBtn').onclick=()=>{pushHistory();state.spec.paths=state.spec.paths.filter(p=>p.id!==state.selected);state.selected=null;render();};
  try{const saved=eda?.sys_Storage?.getExtensionUserConfig(RESULT_KEY);const parsed=typeof saved==='string'?JSON.parse(saved):saved;$('undoApplyBtn').disabled=!parsed?.primitiveId;}catch{}
  await scan(false);try{const recent=JSON.parse(localStorage.getItem('easyedaColor.recentArtwork.v1')||'null');if(recent)$('diagnostics').textContent+=`\n\n最近作品元数据：${recent.backend} · ${recent.steps} 步 · seed ${recent.seed}`;}catch{}
}
let editTimer;function editSelected(change){const p=state.spec?.paths.find(x=>x.id===state.selected);if(!p)return;if(!editTimer){pushHistory();editTimer=setTimeout(()=>editTimer=null,400);}change(p);render();}

if(typeof window!=='undefined'&&typeof document!=='undefined')window.addEventListener('DOMContentLoaded',()=>init().catch(e=>status(`初始化失败：${e.message}`)));

export { DEFAULT_CONFIG, compactScene, createSvg, promptFor };
