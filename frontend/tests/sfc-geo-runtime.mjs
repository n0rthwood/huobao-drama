import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import ts from 'typescript'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

const appDir = resolve(new URL('../app/', import.meta.url).pathname)
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const modules = new Map()
export const notices = []
globalThis.__geoNotices = notices
const external = {
  vue: import.meta.resolve('vue'),
  'vue-i18n': import.meta.resolve('vue-i18n'),
  'lucide-vue-next': import.meta.resolve('lucide-vue-next'),
  'vue-sonner': dataModule('export const toast = Object.fromEntries(["warning","success","error","info"].map(k => [k, value => globalThis.__geoNotices.push({kind:k,value})]))'),
  '~/composables/useQuerySync': deeplinkRuntimeModule,
  '~/utils/url': dataModule('export const mediaUrl = path => path'),
}
export function moduleUrl(file) {
  let path = file.startsWith('/') ? file : resolve(appDir, file)
  if (!existsSync(path)) path += existsSync(`${path}.ts`) ? '.ts' : '.js'
  if (modules.has(path)) return modules.get(path)
  let source = readFileSync(path, 'utf8')
  if (path.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: path })
    source = compileScript(descriptor, { id: path, inlineTemplate: true }).content
  }
  source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  source = source.replace(/from\s+(['"])([^'"]+)\1/g, (whole, quote, name) => {
    const url = external[name] ?? (name.startsWith('~/') ? moduleUrl(resolve(appDir, name.slice(2))) : name.startsWith('.') ? moduleUrl(resolve(dirname(path), name)) : import.meta.resolve(name))
    return `from '${url}'`
  })
  const url = dataModule(source)
  modules.set(path, url)
  return url
}
export async function component(name = 'MapGeoEditor') {
  return (await import(moduleUrl(`map-studio/components/${name}.vue`))).default
}
export const runtime = await import(deeplinkRuntimeModule)
export function allNodes(root) { return [root, ...(root.children ?? []).flatMap(allNodes)] }
export function classes(node) {
  const value = node.props?.class
  if (typeof value === 'string') return value.split(/\s+/)
  if (Array.isArray(value)) return value.flatMap(item => classes({ props: { class: item } }))
  return Object.entries(value ?? {}).filter(([,on]) => on).map(([key]) => key)
}
export function byClass(root, name) { return allNodes(root).filter(node => classes(node).includes(name)) }
export function text(node) { return String(node.text ?? '') + (node.children ?? []).map(text).join('') }
export function button(root, label) { return allNodes(root).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label)) }
export function inputEvent(value) { const target = new globalThis.HTMLInputElement(); target.value = String(value); return { target } }
export const click = { stopPropagation(){}, preventDefault(){} }
let route = 0
export async function mount(t, values, name = 'MapGeoEditor', query = {}) {
  const previous = Object.fromEntries(['HTMLInputElement','HTMLImageElement','Element','window','document'].map(key => [key,globalThis[key]]))
  globalThis.HTMLInputElement = class {}
  globalThis.HTMLImageElement = class {}
  globalThis.Element = class {}
  const document = new EventTarget()
  document.activeElement = null
  globalThis.document = document
  globalThis.window = Object.assign(new EventTarget(), { location: { search: '' } })
  runtime.router.currentRoute.value = { path: `/geo-test-${++route}`, query }
  await nextTick()
  notices.length = 0
  function element(type, value = '') {
    return { type, text: value, props: {}, children: [], parent: null,
      get parentElement() { return this.parent },
      focus() { document.activeElement = this }, querySelector(){ return null }, querySelectorAll(){return []}, contains(){return false},
      listeners: {},
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) },
      removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener) },
      dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener.call(this, event) },
      getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 720 } },
      setPointerCapture(){}, releasePointerCapture(){}, hasPointerCapture(){ return false },
    }
  }
  function remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node),1); node.parent = null }
  const renderer = createRenderer({
    createElement: type => element(type), createText: value => element('#text',value), createComment: () => element('#comment'),
    setText: (node,value) => {node.text = value}, setElementText: (node,value) => {node.text=value;node.children=[]},
    patchProp: (node,key,old,value) => {node.props[key]=value},
    insert(node,parent,anchor=null) {remove(node);const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,node);node.parent=parent},
    remove, parentNode: node=>node.parent, nextSibling: node=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
  })
  const root = element('root')
  const props = reactive(values)
  const instance = ref(null)
  const Comp = await component(name)
  const app = renderer.createApp({ render: () => h(Comp,{...props,ref:instance}) })
  app.use(createI18n({legacy:false,locale:'en',messages:{en:JSON.parse(readFileSync(resolve(appDir,'locales/en.json'),'utf8'))}}))
  app.mount(root)
  runtime.deeplinkHydrate()
  t.after(() => {app.unmount();for(const [key,value] of Object.entries(previous)) {if(value===undefined) delete globalThis[key];else globalThis[key]=value}})
  await nextTick()
  return {root,props,instance:instance.value}
}
export const REGISTRATION = {
  mode: 'program', width:720,height:720,bbox:[0,40,10,50],
  program:{projection:'equirectangular',bbox:[0,40,10,50],scale:720/(10*Math.PI/180),translate:[0,3600]},
}
export const CONTROL_POINTS = [[1,45.5],[5.5,46],[9,45.4],[9,44.7],[5,43.8]]
export function spec() {
  return { version:1,projection:{type:'equirectangular'},bbox:[0,40,10,50],layers:{},style:{theme:'atlas'},
    places:[{id:'p-1',name:'Place',lon:2,lat:45,origin:'dataset',dataset_ref:{ref:'dataset:point'},proposed:true}],
    routes:[{id:'l-1',name:'Line',points:[[1,49],[5,48],[9,49]],origin:'dataset',dataset_ref:{ref:'dataset:line'},proposed:true}],
    regions:[{id:'r-1',name:'Polygon',points:structuredClone(CONTROL_POINTS),origin:'model',proposed:true}],
  }
}
export function propsFor(value) {return {spec:value,persistedSpec:structuredClone(value),registration:REGISTRATION,baseImage:{path:'static/base.png',width:720,height:720},layerDoc:null,layerOptions:{}}}
