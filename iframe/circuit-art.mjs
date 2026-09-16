import { pointInRegion } from './regions.mjs';

// Decorative routes, not electrical nets. Geometry stays in the PCB SVG frame.
export const CIRCUIT_PALETTE = ['#dd7095','#e6ae45','#74bca0','#59aac5','#9b86b7','#e88f65','#89bc62'];

function randomSeed(seed) {
  let value=seed>>>0;
  return ()=>{value+=0x6D2B79F5;let t=value;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}

class Heap {
  items=[];
  push(id,score){const a=this.items;let i=a.length;a.push({id,score});while(i){const p=(i-1)>>1;if(a[p].score<=score)break;a[i]=a[p];i=p;}a[i]={id,score};}
  pop(){const a=this.items,top=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let child=i*2+1;if(child+1<a.length&&a[child+1].score<a[child].score)child++;if(a[child].score>=last.score)break;a[i]=a[child];i=child;}a[i]=last;}return top;}
}

export function generateCircuitArtwork(scene, options={}) {
  const width=scene.viewBox.width,height=scene.viewBox.height;
  if(!(width>0&&height>0))throw new Error('无效板框尺寸');
  const seed=Number(options.seed)>>>0,random=randomSeed(seed);
  const density=Math.max(40,Math.min(220,Number(options.density)||140));
  const lineWidth=Math.max(.7,Math.min(4,Number(options.lineWidth)||1.8));
  const clearance=Math.max(0,Math.min(20,Number(options.clearance ?? 4)));
  const step=Math.max(5,width/210,height/210),radius=lineWidth*1.1;
  const margin=Math.max(width*.012,step*2),cols=Math.floor(width/step),rows=Math.floor(height/step),size=cols*rows;
  const blocked=new Uint8Array(size),used=new Uint8Array(size),safe=[];
  const inflate=clearance+radius+lineWidth/2+step*.75;
  const point=id=>({x:(id%cols+.5)*step,y:(Math.floor(id/cols)+.5)*step});
  for(let id=0;id<size;id++){
    const p=point(id);
    blocked[id]=Number(p.x<margin||p.y<margin||p.x>width-margin||p.y>height-margin||scene.keepouts.some(region=>pointInRegion(p,region,inflate))||(options.isInside&&!options.isInside(p.x,p.y,inflate)));
    if(!blocked[id])safe.push(id);
  }
  const directions=[[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1]];
  // Arrival heading is part of the search state: a different heading at the
  // same cell may be the only way to continue without a right-angle bend.
  const dist=new Float64Array(size*8),parents=new Int32Array(size*8),closed=new Uint8Array(size*8);
  const heuristic=(id,goal)=>{const dx=Math.abs(id%cols-goal%cols),dy=Math.abs(Math.floor(id/cols)-Math.floor(goal/cols));return Math.max(dx,dy)+.4142*Math.min(dx,dy);};
  function route(start,goal){
    dist.fill(Infinity);parents.fill(-1);closed.fill(0);
    const heap=new Heap();let visits=0;
    for(let heading=0;heading<8;heading++){const key=start*8+heading;dist[key]=0;heap.push(key,heuristic(start,goal));}
    while(heap.items.length&&visits++<14000){
      const {id:key}=heap.pop();if(closed[key])continue;const id=Math.floor(key/8),heading=key%8;
      if(id===goal){const result=[];for(let p=key;p!==-1;p=parents[p])result.push(Math.floor(p/8));return new Set(result).size===result.length?result.reverse():null;}closed[key]=1;
      const x=id%cols,y=Math.floor(id/cols);
      for(let direction=0;direction<8;direction++){
        const delta=Math.abs(direction-heading),turnSteps=Math.min(delta,8-delta);
        if(turnSteps>1)continue; // Straight or 45 degrees only, never 90/135/180.
        const [dx,dy]=directions[direction],nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=cols||ny>=rows)continue;
        const next=ny*cols+nx,nextKey=next*8+direction;if(blocked[next]||used[next]||closed[nextKey])continue;
        if(dx&&dy&&(blocked[y*cols+nx]||blocked[ny*cols+x]||used[y*cols+nx]||used[ny*cols+x]))continue;
        const cost=dist[key]+(dx&&dy?1.4142:1)+(turnSteps ? .55 : 0);
        if(cost<dist[nextKey]){dist[nextKey]=cost;parents[nextKey]=key;heap.push(nextKey,cost+heuristic(next,goal));}
      }
    }
    return null;
  }
  const paths=[],routes=[];
  const number=n=>Number(n.toFixed(2));
  function ring(p,color,id){const r=radius;return {id,role:'accent',d:`M ${number(p.x-r)} ${number(p.y)} A ${number(r)} ${number(r)} 0 1 0 ${number(p.x+r)} ${number(p.y)} A ${number(r)} ${number(r)} 0 1 0 ${number(p.x-r)} ${number(p.y)} Z`,fill:options.background||'#fffdf5',stroke:color,strokeWidth:lineWidth*.72,opacity:1};}
  // Long fan-out routes first, then shorter links that fill the remaining gaps.
  for(let attempt=0;attempt<density*16&&routes.length<density;attempt++){
    if(safe.length<2)break;
    const start=safe[Math.floor(random()*safe.length)];if(used[start])continue;
    const p=point(start),long=attempt<density*2;
    const length=(long ? .2+random()*.45 : .035+random()*.13)*Math.min(width,height);
    const dx=random()<.5?1:-1,dy=random()<.5?1:-1;
    const gx=Math.max(2,Math.min(cols-3,Math.round((p.x+dx*length)/step)));
    const gy=Math.max(2,Math.min(rows-3,Math.round((p.y+dy*length*(.3+random()*.7))/step)));
    const goal=gy*cols+gx;if(blocked[goal]||used[goal]||heuristic(start,goal)<7)continue;
    const ids=route(start,goal);if(!ids||ids.length<8)continue;
    ids.forEach(id=>{used[id]=1;});
    const points=ids.map(point),simplified=points.filter((p,i)=>i===0||i===points.length-1||(points[i+1].x-p.x)!==(p.x-points[i-1].x)||(points[i+1].y-p.y)!==(p.y-points[i-1].y));
    const color=CIRCUIT_PALETTE[routes.length%CIRCUIT_PALETTE.length],id=`circuit-${routes.length+1}`;
    paths.push({id,role:'flow',d:simplified.map((p,i)=>`${i?'L':'M'} ${number(p.x)} ${number(p.y)}`).join(' '),fill:'none',stroke:color,strokeWidth:lineWidth,opacity:.94});
    paths.push(ring(points[0],color,`${id}-a`),ring(points.at(-1),color,`${id}-b`));
    routes.push(points);
  }
  if(!routes.length)throw new Error('没有足够开放区域生成装饰走线，请减小留白间距');
  return {version:1,title:'彩虹电路',background:options.background||'#fffdf5',palette:CIRCUIT_PALETTE,paths,style:'rainbow-circuit',printBackground:true,seed,routes,routeCount:routes.length};
}

export function circuitPathHits(path, spec, scene) {
  const index=Number(path.id.match(/^circuit-(\d+)/)?.[1])-1;
  const points=spec.routes[index] || [];
  const padding=path.strokeWidth/2;
  return scene.keepouts.filter(region=>points.some(p=>pointInRegion(p,region,padding)));
}
