/** The only runtime entry point Huobao may import (Issue #99). */
export { mapStudioRoutes } from './routes.js'
export { initMapStudio, openHostTask } from './tasks.js'
export { registerMapStudioHost } from './registry.js'
export type { MapBrief } from './types.js'
export type { MapStudioHostRef, MapStudioHostTarget, MapStudioDeliverable, MapStudioDeliveryResult, MapStudioHost, MapStudioPlatform } from './contract.js'
