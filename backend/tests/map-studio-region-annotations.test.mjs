import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('../', import.meta.url))

test('region labels are annotated idempotently, dataset labels are unchanged, and overflow falls back to a legend', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-region-annotations-'))
  try {
    execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { normalizeLayerDoc } from './src/services/layer-doc.ts'
      import { normalizeMapSpec } from './src/modules/map-studio/geo/base-render.ts'
      import { annotateRegionLabels } from './src/modules/map-studio/region-annotations.ts'
      import { labelProblems } from './src/modules/map-studio/layout/labels.ts'
      import { projectedLabelFeatures,specFeatures } from './src/modules/map-studio/validate.ts'
      import { strictMapLayerDocProblems } from './src/modules/map-studio/layer-doc.ts'
      const spec=normalizeMapSpec({bbox:[0,0,10,10],regions:[
        {id:'source',name:'甲',origin:'source',points:[[2,4],[4,4],[4,6],[2,6]]},
        {id:'dataset',name:'乙',origin:'dataset',points:[[6,4],[8,4],[8,6],[6,6]]}
      ],places:[],routes:[]})
      const registration={mode:'image',width:1000,height:1000,bbox:[0,0,10,10],image:{forward:[100,0,0,0,-100,1000],inverse:[.01,0,0,0,-.01,10],residual_px:{max:0,rms:0},control_points:[],source_url:'',license:''},grid:{lon_min:0,lat_min:0,lon_max:10,lat_max:10,cols:0,rows:0,points:[]}}
      const label=(id,text,x,w)=>({id,type:'label',name:text,text,box:{x,y:.47,w,h:.08},anchor:{semantic_id:id},style:{size:.025}})
      const doc=normalizeLayerDoc({base:{path:'static/map.png',width:1000,height:1000},theme:'clean',layers:[label('source','甲',.24,.3),label('dataset','乙',.64,.3)]})
      const result=annotateRegionLabels(doc,spec,registration)
      assert.equal(result.error,undefined)
      assert.equal(result.doc.layers.find(l=>l.id==='source').text,'甲（示意）')
      assert.equal(result.doc.layers.find(l=>l.id==='dataset').text,'乙')
      assert.deepEqual(annotateRegionLabels(result.doc,spec,registration).doc,result.doc)
      assert.deepEqual(strictMapLayerDocProblems(result.doc,{features:specFeatures(spec),registration}).problems,[])
      assert.deepEqual(labelProblems(result.doc,result.doc.base,projectedLabelFeatures(specFeatures(spec),registration)),[])
      const narrow=structuredClone(doc);narrow.layers[0].box.w=.03
      const fallback=annotateRegionLabels(narrow,spec,registration)
      assert.equal(fallback.error,undefined)
      assert.equal(fallback.doc.layers.find(l=>l.id==='source').text,'甲')
      assert.ok(fallback.doc.layers.some(l=>l.id==='region-schematic-note'&&l.text==='区域为示意范围'))
      assert.deepEqual(strictMapLayerDocProblems(fallback.doc,{features:specFeatures(spec),registration}).problems,[])
      assert.deepEqual(labelProblems(fallback.doc,fallback.doc.base,projectedLabelFeatures(specFeatures(spec),registration)),[])
    `], { cwd: backend, env: { ...process.env, HUOBAO_DATA_DIR: dir }, stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
