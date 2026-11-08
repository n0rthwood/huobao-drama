import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Run the production composable with Vue lifecycle/reactivity and an in-memory
// Nuxt router boundary. Component tests still exercise real setup/render logic.
const vue = import.meta.resolve('vue')
const source = readFileSync(new URL('../app/composables/useQuerySync.ts', import.meta.url), 'utf8')
const runtime = `
import { ref, watch, effectScope, onScopeDispose } from '${vue}'
export const router = {
  currentRoute: ref({ path: '/component-test', query: {} }),
  replace({ query }) {
    router.currentRoute.value = { ...router.currentRoute.value, query }
    return Promise.resolve()
  },
}
const useRouter = () => router
${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText}
`
export const deeplinkRuntimeModule = `data:text/javascript;base64,${Buffer.from(runtime).toString('base64')}`
