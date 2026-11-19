import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick } from 'vue'
import { mount, spec, propsFor, byClass, button, click, inputEvent, CONTROL_POINTS } from './sfc-geo-runtime.mjs'

async function region(t, options = {}) {
  const value = spec(); value.places=[];value.routes=[]
  const mounted = await mount(t,{...propsFor(value),...options})
  byClass(mounted.root,'geo-tab')[2].props.onClick(click)
  await nextTick()
  return mounted
}

test('缺省强度 1：当前面 TAB 实时画平滑曲线、控制点完整、给出所有偏离段',async t=>{
  const {root}=await region(t)
  const [shape]=byClass(root,'geo-region')
  const preview=String(shape.props.points).split(/\s+/)
  assert.ok(preview.length>CONTROL_POINTS.length)
  const [x,y]=preview[0].split(',').map(Number)
  assert.ok(Math.abs(x-72)<1e-6&&Math.abs(y-324)<1e-6)
  assert.equal(byClass(root,'geo-vertex').length,CONTROL_POINTS.length)
  assert.equal(byClass(root,'geo-smooth-warn').length,1)
  assert.equal(byClass(root,'geo-smooth-toggle')[0].props['aria-pressed'],true)
})
test('平滑开关与滑杆只发选项草稿：图层锚定键与强度保持原口径',async t=>{
  const emitted=[]
  const {root}=await region(t,{layerDoc:{layers:[{id:'L-region',type:'polygon',anchor:{semantic_id:'r-1'}}]},onLayerOptions:value=>emitted.push(value)})
  byClass(root,'geo-smooth-toggle')[0].props.onClick(click)
  byClass(root,'geo-smooth-slider')[0].props.onInput(inputEvent('0.4'))
  assert.deepEqual(emitted,[{'L-region':{smooth:0}},{'L-region':{smooth:0.4}}])
})
test('无落地图层时平滑选项使用要素 id，关闭后回原始控制点折线',async t=>{
  const emitted=[]
  const {root}=await region(t,{layerOptions:{'r-1':{smooth:0}},onLayerOptions:value=>emitted.push(value)})
  assert.equal(String(byClass(root,'geo-region')[0].props.points).split(/\s+/).length,CONTROL_POINTS.length)
  assert.equal(byClass(root,'geo-smooth-warn').length,0)
  byClass(root,'geo-smooth-toggle')[0].props.onClick(click)
  assert.deepEqual(emitted,[{'r-1':{smooth:1}}])
})
test('边列表显式插点：相邻经纬度中点，原点保持、转 manual/confirmed',async t=>{
  const value=spec();value.places=[];value.routes=[]
  Object.assign(value.regions[0],{origin:'dataset',dataset_ref:{ref:'ne:10m_lakes:1'},category:'lake',relations:[{id:'rel-1'}],verification:{status:'verified',reasons:['dataset']}})
  let updated
  const {root}=await mount(t,{...propsFor(value),onUpdate:next=>updated=next})
  byClass(root,'geo-tab')[2].props.onClick(click);await nextTick()
  byClass(root,'geo-count')[0].props.onClick(click);await nextTick()
  button(root,'Insert on selected edge').props.onClick(click)
  assert.equal(updated.regions[0].points.length,CONTROL_POINTS.length+1)
  assert.deepEqual(updated.regions[0].points[1],[3.25,45.75])
  assert.deepEqual(updated.regions[0].points.filter((_,i)=>i!==1),CONTROL_POINTS)
  assert.equal(updated.regions[0].origin,'manual')
  assert.equal(updated.regions[0].verification.status,'confirmed')
  assert.equal('proposed' in updated.regions[0],false)
  assert.equal('dataset_ref' in updated.regions[0],false)
  assert.equal(updated.regions[0].category,'lake')
  assert.deepEqual(updated.regions[0].relations,value.regions[0].relations)
})
test('没有底图/配准也可预设平滑：模型默认开、数据集默认关',async t=>{
  for(const origin of ['model','dataset']) await t.test(origin,async child=>{
    const value=spec();value.regions[0].origin=origin
    const emitted=[]
    const {root}=await mount(child,{...propsFor(value),registration:null,baseImage:null,onLayerOptions:next=>emitted.push(next)})
    byClass(root,'geo-tab')[2].props.onClick(click);await nextTick()
    assert.equal(byClass(root,'geo-smooth-toggle')[0].props['aria-pressed'],origin!=='dataset')
    byClass(root,'geo-smooth-toggle')[0].props.onClick(click)
    assert.deepEqual(emitted,[{'r-1':{smooth:origin==='dataset'?1:0}}])
  })
})
test('建议强度取所有超限段最小值；只有显式点击才写选项，整条曲线复算',async t=>{
  let mounted;const updates=[];const geometry=[]
  mounted=await region(t,{onUpdate:value=>geometry.push(value),onLayerOptions:value=>{updates.push(value);mounted.props.layerOptions=value}})
  assert.equal(updates.length,0)
  const action=byClass(mounted.root,'geo-smooth-actions')[0].children.find(node=>node.type==='button')
  action.props.onClick(click);await nextTick()
  assert.equal(updates.length,1)
  assert.equal(geometry.length,0)
  const {deviationProblems}=await import('../app/map-studio/utils/smooth.js')
  const normalized=CONTROL_POINTS.map(([lon,lat])=>[lon/10,(50-lat)/10])
  assert.equal(deviationProblems(normalized,{closed:true,strength:updates[0]['r-1'].smooth,width:720,height:720}).length,0)
})
test('舍入相同仍标超限，精确值可点击与键盘读取；建议 0 只显示关闭',async t=>{
  const values={featureName:'Fixture',problems:[{segment:1,deviation:18.03,limit:17.98,suggested:0}],strength:1,canPreview:true,disabled:false}
  const {root}=await mount(t,values,'geo/GeoSmoothWarning')
  const {text}=await import('./sfc-geo-runtime.mjs')
  assert.ok(text(root).includes('18.0px (over limit)'))
  button(root,'Exact values').props.onClick(click);await nextTick()
  assert.ok(text(root).includes('18.03px'))
  assert.ok(text(root).includes('17.98px'))
  assert.equal(byClass(root,'geo-smooth-actions')[0].children.filter(n=>n.type==='button').length,1)
  assert.ok(button(root,'Turn smoothing off'))
})
