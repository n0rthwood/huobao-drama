/**
 * 「背景信息载体」（exposition，Issue #47）
 *
 * 旁白提到、但本集**不出场**、却需要一个视觉载体才能讲清楚的实体：
 * 组织（谢苗诺夫近卫团）、不在场的人物（彼得一世）、异地事件/地点（波尔塔瓦）。
 *
 * 事故诊断里这一类实体完全没有落点：场景提取规定「不含人物」、角色只能 `@名字`，
 * 于是 S13「近卫团出身、受彼得一世器重」只能退化成「一个人站在空操场」。
 *
 * 实现上**不新增第 4 类资产**（kind 三元联合在 15 处硬编码）：
 * 仍按角色/场景/道具三类落库，只是多一个 `exposition` 标记列，
 * 并在角色的 `role` / 道具的 `type` 上写一个人能看见的前缀，
 * 供表达设计（#49）把它们单列成 `exposition_assets`。
 */

/** 人可见的标记词；写在角色 role 前缀与道具 type 上 */
export const EXPOSITION_MARKER = '背景信息载体'
const MARKER_SEPARATOR = ' · '

/**
 * 角色 `role` / 道具 `type` 的标记写法：已经带标记就原样返回，空值直接用标记本身。
 * 三类资产的这个字段在资产库里就是副标题（`asset-library.ts` 的 `subtitle`），
 * 所以打在这里，人在任何列表里都能一眼区分「出场实体」与「背景信息载体」。
 */
export function markExposition(value: string | null | undefined): string {
  const text = (value || '').trim()
  if (!text) return EXPOSITION_MARKER
  if (text === EXPOSITION_MARKER || text.startsWith(`${EXPOSITION_MARKER}${MARKER_SEPARATOR}`)) return text
  return `${EXPOSITION_MARKER}${MARKER_SEPARATOR}${text}`
}
