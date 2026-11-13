/** Measured geographic control grid. Interpolation never extrapolates beyond actual controls. */
export interface GeoPixelGrid {
  lon_min: number
  lat_min: number
  lon_max: number
  lat_max: number
  cols: number
  rows: number
  points: Array<[number, number] | null>
}

export function gridGeoToNormalized(grid: GeoPixelGrid, geo: [number, number]): [number, number] | null {
  if (geo[0] < grid.lon_min || geo[0] > grid.lon_max || geo[1] < grid.lat_min || geo[1] > grid.lat_max) return null
  const x = (geo[0] - grid.lon_min) / (grid.lon_max - grid.lon_min) * (grid.cols - 1)
  const y = (grid.lat_max - geo[1]) / (grid.lat_max - grid.lat_min) * (grid.rows - 1)
  const col = Math.min(grid.cols - 2, Math.floor(x))
  const row = Math.min(grid.rows - 2, Math.floor(y))
  const a = grid.points[row * grid.cols + col]
  const b = grid.points[row * grid.cols + col + 1]
  const c = grid.points[(row + 1) * grid.cols + col]
  const d = grid.points[(row + 1) * grid.cols + col + 1]
  if (!a || !b || !c || !d) return null
  const u = x - col
  const v = y - row
  return [
    a[0] * (1-u)*(1-v) + b[0]*u*(1-v) + c[0]*(1-u)*v + d[0]*u*v,
    a[1] * (1-u)*(1-v) + b[1]*u*(1-v) + c[1]*(1-u)*v + d[1]*u*v,
  ]
}

export function gridNormalizedToGeo(grid: GeoPixelGrid, point: [number, number]): [number, number] | null {
  for (let row = 0; row < grid.rows - 1; row++) {
    for (let col = 0; col < grid.cols - 1; col++) {
      const a = grid.points[row * grid.cols + col]
      const b = grid.points[row * grid.cols + col + 1]
      const c = grid.points[(row + 1) * grid.cols + col]
      const d = grid.points[(row + 1) * grid.cols + col + 1]
      if (!a || !b || !c || !d) continue
      if (point[0] < Math.min(a[0],b[0],c[0],d[0]) - 1e-10
        || point[0] > Math.max(a[0],b[0],c[0],d[0]) + 1e-10
        || point[1] < Math.min(a[1],b[1],c[1],d[1]) - 1e-10
        || point[1] > Math.max(a[1],b[1],c[1],d[1]) + 1e-10) continue
      let u = .5
      let v = .5
      let error = Infinity
      for (let step = 0; step < 16; step++) {
        const ex = a[0]*(1-u)*(1-v) + b[0]*u*(1-v) + c[0]*(1-u)*v + d[0]*u*v - point[0]
        const ey = a[1]*(1-u)*(1-v) + b[1]*u*(1-v) + c[1]*(1-u)*v + d[1]*u*v - point[1]
        error = Math.hypot(ex, ey)
        if (error < 1e-10) break
        const dxdu = (b[0]-a[0])*(1-v) + (d[0]-c[0])*v
        const dydu = (b[1]-a[1])*(1-v) + (d[1]-c[1])*v
        const dxdv = (c[0]-a[0])*(1-u) + (d[0]-b[0])*u
        const dydv = (c[1]-a[1])*(1-u) + (d[1]-b[1])*u
        const determinant = dxdu*dydv - dxdv*dydu
        if (Math.abs(determinant) < 1e-15) break
        u -= (ex*dydv - ey*dxdv) / determinant
        v -= (ey*dxdu - ex*dydu) / determinant
      }
      if (error > 1e-8 || u < -1e-8 || u > 1+1e-8 || v < -1e-8 || v > 1+1e-8) continue
      return [
        grid.lon_min + (col+u)/(grid.cols-1)*(grid.lon_max-grid.lon_min),
        grid.lat_max - (row+v)/(grid.rows-1)*(grid.lat_max-grid.lat_min),
      ]
    }
  }
  return null
}
