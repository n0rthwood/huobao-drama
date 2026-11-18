/**
 * 出图路由（Issue #56）
 *
 * 资产实验的实测结论（~/projects/huobao-asset-lab/report.md）：
 * - **qwen** 风格统一、出片好看，但会按自己的理解重画结构（地图海岸线被改写就是它）；
 * - **gpt-image**（codex 包装服务，provider=`openai`）结构保真明显更好，风格偏「插画」。
 *
 * 所以精确轮优先结构型（gpt-image），美化轮优先风格型（qwen-jobs）。匹配不到就回退到
 * 当前启用的图片配置，并在轮次行记 `generator_fallback:` 前缀——出了问题要能一眼看出
 * 这一轮根本没用上期望的那条配置。
 *
 * Issue #73 起，新发起的 run 在启动时就由 `resolveImageSelection()` 把配置与模型定死
 * （人没选时默认 GPT Image），整条 run 都用它；下面这套按用途择优只对启动时没有冻结
 * 配置的老 run 生效。
 */
export function sizeBucketFor(width: number, height: number): string {
  const ratio = width / Math.max(height, 1)
  const buckets: Array<{ size: string; ratio: number }> = [
    { size: '1344x768', ratio: 16 / 9 },
    { size: '1152x864', ratio: 4 / 3 },
    { size: '1024x1024', ratio: 1 },
    { size: '864x1152', ratio: 3 / 4 },
    { size: '768x1344', ratio: 9 / 16 },
  ]
  let best = buckets[0]!
  for (const bucket of buckets) {
    if (Math.abs(Math.log(bucket.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio))) best = bucket
  }
  return best.size
}
