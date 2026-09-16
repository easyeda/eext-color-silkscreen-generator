export function regionPoints(region) {
  return Array.isArray(region?.points) && region.points.length >= 3 ? region.points : [
    {x:region.minX,y:region.minY},{x:region.maxX,y:region.minY},
    {x:region.maxX,y:region.maxY},{x:region.minX,y:region.maxY},
  ];
}

export function pointsBounds(points) {
  return {minX:Math.min(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxX:Math.max(...points.map(p=>p.x)),maxY:Math.max(...points.map(p=>p.y))};
}

export function pointInRegion(point,region,padding=0) {
  const points=regionPoints(region);let inside=false,minDistance=Infinity;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i];
    if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    const dx=b.x-a.x,dy=b.y-a.y,length2=dx*dx+dy*dy;
    const t=length2?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length2)):0;
    minDistance=Math.min(minDistance,Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy)));
  }
  return inside||minDistance<=padding;
}

export function componentRegion(fullBox,pinPoints,category,origin,rotation=0) {
  const angle=((Number(rotation)%360)+360)%360,axisDistance=Math.min(angle%90,90-angle%90);
  if(axisDistance<.01||!origin||!Number.isFinite(origin.x)||!Number.isFinite(origin.y)||pinPoints.length<2)return {...fullBox,rotation:angle};
  const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
  const local=pinPoints.map(p=>({x:(p.x-origin.x)*c+(p.y-origin.y)*s,y:-(p.x-origin.x)*s+(p.y-origin.y)*c}));
  const localBounds=pointsBounds(local),span=Math.max(localBounds.maxX-localBounds.minX,localBounds.maxY-localBounds.minY);
  if(span<1)return {...fullBox,rotation:angle};
  const margin=Math.max(8,Math.min(40,span*(category==='connector'?.1:.06)));
  const corners=[{x:localBounds.minX-margin,y:localBounds.minY-margin},{x:localBounds.maxX+margin,y:localBounds.minY-margin},
    {x:localBounds.maxX+margin,y:localBounds.maxY+margin},{x:localBounds.minX-margin,y:localBounds.maxY+margin}]
    .map(p=>({x:origin.x+p.x*c-p.y*s,y:origin.y+p.x*s+p.y*c}));
  return {...fullBox,...pointsBounds(corners),points:corners,rotation:angle};
}
