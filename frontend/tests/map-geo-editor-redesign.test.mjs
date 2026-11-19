import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick } from 'vue'
import { mount, spec, propsFor, moduleUrl, byClass, allNodes, button, click, inputEvent, text, runtime, notices } from './sfc-geo-runtime.mjs'
const coords=await import(moduleUrl('map-studio/components/geo/coords.ts'))
const canonical=await import(moduleUrl('map-studio/components/geo/canonical.ts'))
const feature=await import(moduleUrl('map-studio/components/geo/feature.ts'))
const registration=await import(moduleUrl('map-studio/utils/mapRegistration.ts'))

const SIZE={width:2048,height:1280}
const SCALE=900/2048
const VIEW={zoom:2.5,cx:(1024-120/(SCALE*2.5))/2048,cy:(640+80/(SCALE*2.5))/1280}
const FIXTURE={mode:'image',...SIZE,bbox:[100,20,140,60],image:{forward:[2048/40,0,-100*2048/40,0,-1280/40,60*1280/40],inverse:[40/2048,0,100,0,-40/1280,60]}}

test('三级坐标 oracle：meet、zoom、pan、偏移、border/padding、DPR均不重复变换',()=>{
  for(const dpr of [1,2]) {
    // client 坐标始终为 CSS px；DPR 只影响截图物理像素。
    const vb=coords.screenToViewBox({x:512,y:362},{left:100,top:50,width:924,height:644,border:2,padding:10},SIZE,VIEW)
    assert.ok(Math.abs(vb[0]-869.2622222222222)<=1e-6,`DPR=${dpr}`)
    assert.ok(Math.abs(vb[1]-703.7155555555555)<=1e-6)
    const geo=registration.pixelToGeo(FIXTURE,...vb)
    assert.ok(Math.abs(geo[0]-5264/45)<=1e-7)
    assert.ok(Math.abs(geo[1]-8552/225)<=1e-7)
    const back=registration.geoToPixel(FIXTURE,...geo)
    assert.ok(Math.abs(back[0]-vb[0])<1e-6)
  }
})
test('视图数学：指针缩放保留落点、pan可逆、clamp不触碰坐标',()=>{
  const rect={left:0,top:0,width:900,height:620}
  const before=coords.screenToViewBox({x:400,y:300},rect,SIZE,VIEW)
  const next=coords.zoomAround({x:400,y:300},rect,SIZE,VIEW,3)
  const after=coords.screenToViewBox({x:400,y:300},rect,SIZE,next)
  assert.ok(Math.abs(before[0]-after[0])<1e-6&&Math.abs(before[1]-after[1])<1e-6)
  assert.equal(coords.normalizeView({zoom:'99'}).view.zoom,16)
  assert.equal(coords.normalizeView({zoom:'0.1'}).view.zoom,1)
  assert.equal(coords.normalizeView({zoom:'Infinity'}).view.zoom,1)
  assert.equal(coords.normalizeView({zoom:'NaN'}).adjustedZoom,true)
  assert.deepEqual(coords.normalizeView({zoom:2,cx:'NaN',cy:'.3'}).view,{zoom:2,cx:.5,cy:.5})
})
test('hash只绑定坐标序列：改名/状态不变、相邻double/插点/闭合顺序变化失效',()=>{
  const a={name:'A',points:[[100,20],[101,21]]}
  const original=canonical.featureGeometryHash(a)
  assert.equal(canonical.featureGeometryHash({...a,name:'B',revision:77}),original)
  assert.notEqual(canonical.featureGeometryHash({points:[[100,20],[101.00000000000001,21]]}),original)
  assert.notEqual(canonical.featureGeometryHash({points:[[101,21],[100,20]]}),original)
  assert.notEqual(canonical.featureGeometryHash({points:[[100,20],[101,21],[100,20]]}),original)
})
test('待核对数量与 geometryUnverified 同口径，dataset_missing 无条件计入',()=>{
  for(const origin of ['manual','dataset','model']) for(const status of ['proposed','verified','confirmed']) for(const proposed of [false,true]) {
    const row={id:'a',name:'A',origin,proposed,verification:{status,reasons:[]}}
    assert.equal(feature.isGeometryUnverified(row),proposed&&origin!=='manual'&&!['verified','confirmed'].includes(status))
    row.verification.reasons=['dataset_missing: fixture']
    assert.equal(feature.isGeometryUnverified(row),true)
  }
})
test('TAB硬显隐：只创建当前类SVG、底图保留，各类草稿不丢，零几何事件',async t=>{
  const writes=[];const {root}=await mount(t,{...propsFor(spec()),onUpdate:v=>writes.push(v)})
  assert.equal(byClass(root,'geo-place').length,1)
  assert.equal(byClass(root,'geo-route').length,0)
  assert.equal(byClass(root,'geo-region').length,0)
  for(const [tab,kind] of [[1,'geo-route'],[2,'geo-region'],[0,'geo-place']]) {
    byClass(root,'geo-tab')[tab].props.onClick(click);await nextTick()
    assert.equal(byClass(root,kind).length,1)
    assert.equal(byClass(root,'geo-base').length,1)
  }
  assert.equal(writes.length,0)
})
test('地点主列表完整编辑：名称不转人工，坐标即时草稿/预览，删除独立可见',async t=>{
  let mounted;const writes=[]
  mounted=await mount(t,{...propsFor(spec()),onUpdate:v=>{writes.push(v);mounted.props.spec=v}})
  byClass(mounted.root,'geo-name')[0].props.onInput(inputEvent('Renamed'));await nextTick()
  assert.equal(writes[0].places[0].origin,'dataset')
  assert.equal(writes[0].places[0].proposed,true)
  byClass(mounted.root,'geo-coord')[0].props.onInput(inputEvent('3.123456789'));await nextTick()
  assert.equal(mounted.props.spec.places[0].lon,3.123456789)
  assert.equal(mounted.props.spec.places[0].origin,'manual')
  assert.equal('dataset_ref' in mounted.props.spec.places[0],false)
  assert.ok(Math.abs(byClass(mounted.root,'geo-place')[0].props.cx-3.123456789*72)<1e-6)
  button(mounted.root,'Delete place').props.onClick(click);await nextTick()
  assert.equal(mounted.props.spec.places.length,0)
})
test('全部地点弹窗有效编辑即时加入唯一草稿，关闭无第二次提交，丢输入不回滚',async t=>{
  let mounted;const writes=[]
  mounted=await mount(t,{...propsFor(spec()),onUpdate:v=>{writes.push(v);mounted.props.spec=v}})
  button(mounted.root,'All places').props.onClick(click);await nextTick()
  const input=allNodes(mounted.root).find(n=>n.props['data-input']==='p-1:lon')
  input.props.onInput(inputEvent('3.75'));await nextTick()
  assert.equal(mounted.props.spec.places[0].lon,3.75)
  input.props.onInput(inputEvent('-'));await nextTick()
  button(mounted.root,'Close').props.onClick(click);await nextTick()
  assert.ok(button(mounted.root,'Discard incomplete input and close'))
  button(mounted.root,'Discard incomplete input and close').props.onClick(click);await nextTick()
  assert.equal(writes.length,1)
  assert.equal(mounted.props.spec.places[0].lon,3.75)
})
test('普通顶点表坐标/删点同通道，下限拒绝 alert+toast 且零更新',async t=>{
  let mounted;const writes=[]
  mounted=await mount(t,{...propsFor(spec()),onUpdate:v=>{writes.push(v);mounted.props.spec=v}})
  byClass(mounted.root,'geo-tab')[1].props.onClick(click);await nextTick()
  byClass(mounted.root,'geo-count')[0].props.onClick(click);await nextTick()
  allNodes(mounted.root).find(n=>n.props['data-input']==='0:lon').props.onInput(inputEvent('1.125'));await nextTick()
  assert.equal(writes.length,1)
  assert.equal(mounted.props.spec.routes[0].points[0][0],1.125)
  button(mounted.root,'Delete vertex 1 of “Line”').props.onClick(click);await nextTick()
  assert.equal(mounted.props.spec.routes[0].points.length,2)
  const before=writes.length
  button(mounted.root,'Delete vertex 1 of “Line”').props.onClick(click);await nextTick()
  assert.equal(writes.length,before)
  assert.ok(text(mounted.root).includes('A line needs at least 2 vertices'))
  assert.ok(notices.some(n=>n.kind==='warning'))
})
test('键盘数值路径：无registration从零建线、追加、插点、完成仅本地；无变化完成零更新',async t=>{
  let mounted;const writes=[]
  mounted=await mount(t,{...propsFor(spec()),registration:null,onUpdate:v=>{writes.push(v);mounted.props.spec=v}})
  byClass(mounted.root,'geo-tab')[1].props.onClick(click);await nextTick()
  byClass(mounted.root,'geo-add-current')[0].props.onClick(click);await nextTick()
  assert.equal(mounted.instance.hasPendingInput(),true)
  for(const [lon,lat] of [[1,41],[2,42]]) {
    allNodes(mounted.root).find(n=>n.props['data-input']==='append:lon').props.onInput(inputEvent(lon))
    allNodes(mounted.root).find(n=>n.props['data-input']==='append:lat').props.onInput(inputEvent(lat));await nextTick()
    button(mounted.root,'Append vertex').props.onClick(click);await nextTick()
  }
  assert.equal(writes.length,0)
  button(mounted.root,'Insert on selected edge').props.onClick(click);await nextTick()
  button(mounted.root,'Close').props.onClick(click);await nextTick()
  byClass(mounted.root,'geo-finish')[0].props.onClick(click);await nextTick()
  assert.equal(writes.length,1)
  assert.equal(mounted.props.spec.routes.at(-1).points.length,3)
  assert.equal(mounted.instance.hasPendingInput(),false)
  const continues=allNodes(mounted.root).filter(n=>n.props['data-continue'])
  continues[0].props.onClick(click);await nextTick()
  byClass(mounted.root,'geo-finish')[0].props.onClick(click);await nextTick()
  assert.equal(writes.length,1)
})
test('有效行链接先校验hash再定位；坐标hash错误/缺失/行越界退要素级，零写入',async t=>{
  const value=spec();const hash=canonical.featureGeometryHash(value.routes[0])
  for(const [row,revision,expected] of [['2',hash,true],['2','wrong',false],['2',undefined,false],['999',hash,false]]) {
    await t.test(`${row}/${revision}`,async child=>{
      const writes=[];const mounted=await mount(child,{...propsFor(value),onUpdate:v=>writes.push(v) },'MapGeoEditor',{msgtab:'point',msgpoints:'route:l-1',msgrow:row,msggeorev:revision,msgzoom:'99',msgcx:'.4',msgcy:'.6'})
      assert.equal(byClass(mounted.root,'geo-tab')[1].props['aria-selected'],true)
      assert.equal(byClass(mounted.root,'geo-dialog').length,1)
      assert.equal(byClass(mounted.root,'geo-dialog-linked').length,expected?1:0)
      assert.equal(text(byClass(mounted.root,'geo-zoom-value')[0]),'1600%')
      assert.equal(writes.length,0)
      button(mounted.root,'Close').props.onClick(click);await nextTick()
      assert.equal(runtime.router.currentRoute.value.query.msgpoints,undefined)
      assert.equal(runtime.router.currentRoute.value.query.msgtab,'line')
      assert.equal(runtime.router.currentRoute.value.query.msgzoom,'16')
    })
  }
})

const pointer=(x,y,pointerType='mouse',pointerId=1)=>({clientX:x,clientY:y,pointerId,pointerType,preventDefault(){},stopPropagation(){}})
async function canvas(t) {
  const value=spec();const shape=value.routes[0]
  const events={geometry:[],view:[],append:[]}
  let mounted
  const pixels=shape.points.map(p=>registration.geoToPixel(propsFor(value).registration,...p))
  mounted=await mount(t,{...propsFor(value),baseUrl:'base.png',size:{width:720,height:720},view:{zoom:1,cx:.5,cy:.5},tab:'route',tool:'select',disabled:false,shapes:[{...shape,kind:'route',attr:pixels.map(p=>p.join(',')).join(' '),visible:true}],draft:null,selected:null,selectedVertex:null,selectedEdge:null,onView:v=>{events.view.push(v);mounted.props.view=v},onVertexDragEnd:v=>events.geometry.push(v),onAppendDraft:v=>events.append.push(v)},'geo/GeoCanvas')
  return {...mounted,events,svg:byClass(mounted.root,'geo-overlay')[0]}
}
test('mouse/touch/pen 独立拖点：pointerup才提交，屏幕缩放不写几何',async t=>{
  for(const type of ['mouse','touch','pen']) await t.test(type,async child=>{
    const c=await canvas(child)
    c.svg.props.onPointerdown(pointer(72,72,type));c.svg.props.onPointermove(pointer(144,144,type));assert.equal(c.events.geometry.length,0)
    c.svg.props.onPointerup(pointer(144,144,type))
    assert.equal(c.events.geometry.length,1)
    assert.ok(Math.abs(c.events.geometry[0].lon-2)<1e-7&&Math.abs(c.events.geometry[0].lat-48)<1e-7)
    byClass(c.root,'geo-view-btn')[0].props.onClick(click);await nextTick()
    assert.equal(c.events.geometry.length,1)
    assert.ok(c.props.view.zoom>1)
  })
})
test('gesture取消/无变化零几何提交：第二触点、cancel、Esc、阈值、拖回原点',async t=>{
  for(const action of ['second','cancel','escape','threshold','return']) await t.test(action,async child=>{
    const c=await canvas(child)
    c.svg.props.onPointerdown(pointer(72,72,'touch'))
    if(action==='threshold') c.svg.props.onPointermove(pointer(74,74,'touch'))
    else c.svg.props.onPointermove(pointer(144,144,'touch'))
    if(action==='second') c.svg.props.onPointerdown(pointer(150,150,'touch',2))
    if(action==='cancel') c.svg.props.onPointercancel(pointer(144,144,'touch'))
    if(action==='escape') byClass(c.root,'geo-stage')[0].props.onKeydown({key:'Escape',stopPropagation(){}})
    c.svg.props.onPointerup(pointer(action==='return'?72:144,action==='return'?72:144,'touch'))
    assert.equal(c.events.geometry.length,0)
  })
})

test('zoomed_vertex_drag_projects_correctly：真实组件调用registration逆映射，保留oracle精度',async t=>{
  const events=[]
  const point=[110,40]
  const value={baseUrl:'fixture.png',registration:FIXTURE,size:SIZE,view:VIEW,tab:'route',tool:'select',disabled:false,shapes:[{kind:'route',id:'oracle',name:'Oracle',points:[point,[130,50]],attr:'',dataset:false,pending:false,visible:true}],draft:null,selected:null,selectedVertex:null,selectedEdge:null,onVertexDragEnd:v=>events.push(v)}
  const c=await mount(t,value,'geo/GeoCanvas')
  const svg=byClass(c.root,'geo-overlay')[0]
  svg.getBoundingClientRect=()=>({left:112,top:62,width:900,height:620})
  const start=coords.viewBoxToScreen(registration.geoToPixel(FIXTURE,...point),{left:112,top:62,width:900,height:620},SIZE,VIEW)
  svg.props.onPointerdown(pointer(...start))
  svg.props.onPointermove(pointer(512,362))
  svg.props.onPointerup(pointer(512,362))
  assert.equal(events.length,1)
  assert.ok(Math.abs(events[0].lon-5264/45)<=1e-7)
  assert.ok(Math.abs(events[0].lat-8552/225)<=1e-7)
})
test('view_gestures_never_write_geometry：滚轮/按钮/键盘/拖拽平移/适配/重置仅发view',async t=>{
  const c=await canvas(t)
  for(const btn of byClass(c.root,'geo-view-btn')) btn.props.onClick(click)
  const stage=byClass(c.root,'geo-stage')[0]
  stage.focus();stage.props.onFocus()
  stage.props.onWheel({deltaY:-100,clientX:360,clientY:360,preventDefault(){}})
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-','0']) stage.props.onKeydown({key,preventDefault(){}})
  c.props.tool='pan';await nextTick()
  c.svg.props.onPointerdown(pointer(500,500,'pen'));c.svg.props.onPointermove(pointer(600,600,'pen'));c.svg.props.onPointerup(pointer(600,600,'pen'))
  assert.ok(c.events.view.length>10)
  assert.equal(c.events.geometry.length,0)
  assert.equal(c.events.append.length,0)
})
test('mouse/touch/pen 新建追加在pointerup才生效，第二触点取消不追加',async t=>{
  for(const type of ['mouse','touch','pen']) await t.test(type,async child=>{
    const c=await canvas(child);c.props.tool='draw';await nextTick()
    c.svg.props.onPointerdown(pointer(360,360,type))
    assert.equal(c.events.append.length,0)
    c.svg.props.onPointerup(pointer(360,360,type))
    assert.equal(c.events.append.length,1)
    c.svg.props.onPointerdown(pointer(400,400,type))
    c.svg.props.onPointerdown(pointer(450,450,'touch',2))
    c.svg.props.onPointerup(pointer(400,400,type))
    c.svg.props.onPointerup(pointer(450,450,'touch',2))
    assert.equal(c.events.append.length,1)
  })
})
test('double_click_deletes_once：同顶点两次无拖动点击删除一次，拖动后双击不误删',async t=>{
  const c=await canvas(t);const deletes=[];c.props.onDeleteVertex=v=>deletes.push(v);await nextTick()
  for(let i=0;i<2;i++){c.svg.props.onPointerdown(pointer(72,72));c.svg.props.onPointerup(pointer(72,72))}
  c.svg.props.onDblclick(pointer(72,72))
  assert.equal(deletes.length,1)
  c.svg.props.onPointerdown(pointer(72,72));c.svg.props.onPointermove(pointer(100,100));c.svg.props.onPointerup(pointer(100,100))
  c.svg.props.onDblclick(pointer(72,72))
  assert.equal(deletes.length,1)
})
test('overlap_choice_is_explicit：同级命中重叠时返回候选，不任意拖动首项',async t=>{
  const c=await canvas(t);const overlaps=[]
  c.props.shapes=[...c.props.shapes,{...c.props.shapes[0],id:'other'}]
  c.props.onOverlap=v=>overlaps.push(v);await nextTick()
  c.svg.props.onPointerdown(pointer(72,72));c.svg.props.onPointerup(pointer(144,144))
  assert.equal(overlaps.length,1)
  assert.equal(overlaps[0].length,2)
  assert.equal(c.events.geometry.length,0)
})

test('前进后退恢复零写入；活动形状先仲裁，取消只丢事务后恢复目标TAB',async t=>{
  const writes=[];const c=await mount(t,{...propsFor(spec()),onUpdate:v=>writes.push(v)})
  window.location.search='?msgtab=line&msgzoom=3&msgcx=.4&msgcy=.6'
  window.dispatchEvent(new Event('popstate'));await nextTick()
  assert.equal(byClass(c.root,'geo-tab')[1].props['aria-selected'],true)
  assert.equal(text(byClass(c.root,'geo-zoom-value')[0]),'300%')
  byClass(c.root,'geo-add-current')[0].props.onClick(click);await nextTick()
  window.location.search='?msgtab=region'
  window.dispatchEvent(new Event('popstate'));await nextTick()
  assert.equal(byClass(c.root,'geo-dialog').length,0)
  assert.ok(button(c.root,'Cancel shape and switch'))
  assert.equal(button(c.root,'Finish and switch').props.disabled,true)
  button(c.root,'Cancel shape and switch').props.onClick(click);await nextTick()
  assert.equal(byClass(c.root,'geo-tab')[2].props['aria-selected'],true)
  assert.equal(writes.length,0)
})
test('全部地点分页保持原序号、有效编辑同草稿、跨页保留无效输入和保存守卫',async t=>{
  const value=spec()
  value.places=Array.from({length:60},(_,i)=>({id:`p-${i}`,name:`Place ${i}`,lon:i,lat:45,origin:'manual'}))
  let c;const writes=[]
  c=await mount(t,{...propsFor(value),onUpdate:v=>{writes.push(v);c.props.spec=v}})
  button(c.root,'All places').props.onClick(click);await nextTick()
  button(c.root,'Next').props.onClick(click);await nextTick()
  let input=allNodes(c.root).find(n=>n.props['data-input']==='p-50:lon')
  input.props.onInput(inputEvent('51.25'));await nextTick()
  assert.equal(c.props.spec.places[50].lon,51.25)
  input.props.onInput(inputEvent('-'));await nextTick()
  assert.equal(c.instance.hasPendingInput(),true)
  button(c.root,'Previous').props.onClick(click);await nextTick()
  button(c.root,'Next').props.onClick(click);await nextTick()
  input=allNodes(c.root).find(n=>n.props['data-input']==='p-50:lon')
  assert.equal(input.props.value,'-')
  button(c.root,'Close').props.onClick(click);await nextTick()
  button(c.root,'Discard incomplete input and close').props.onClick(click);await nextTick()
  assert.equal(c.instance.hasPendingInput(),false)
  assert.equal(writes.length,1)
})

test('页面补齐style/layers不冒称几何已脏，只有实际可编辑字段变化才标草稿',async t=>{
  const saved=spec(),current=structuredClone(saved)
  current.style={theme:'archival'};current.layers={land:true,coastline:true}
  const c=await mount(t,{...propsFor(current),persistedSpec:saved})
  assert.equal(byClass(c.root,'geo-draft-status').length,0)
  c.props.spec={...current,places:current.places.map(p=>({...p,name:'Changed'}))};await nextTick()
  assert.equal(byClass(c.root,'geo-draft-status').length,1)
})
test('重叠地点同样列候选，不依数组顺序命中第一个',async t=>{
  const c=await canvas(t),overlaps=[]
  c.props.tab='place'
  c.props.shapes=['a','b'].map(id=>({kind:'place',id,name:id,points:[[5,45]],attr:'',visible:true,pending:false,dataset:false}))
  c.props.onOverlap=v=>overlaps.push(v);await nextTick()
  c.svg.props.onPointerdown(pointer(360,360));c.svg.props.onPointerup(pointer(400,400))
  assert.equal(overlaps[0].length,2)
  assert.equal(c.events.geometry.length,0)
})
