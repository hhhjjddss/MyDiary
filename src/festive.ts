/** 节日提示：完全以节假日 API 当天数据为准 */

export interface HolidayInfo {
  name: string
  type: 'holiday' | 'work'
}

/** 返回今天接口上的放假日名；不是放假日则 null */
export function holidayNameOf(
  today: string,
  holidays: Record<string, HolidayInfo>,
): string | null {
  const info = holidays[today]
  if (info?.type === 'holiday' && info.name) return info.name
  return null
}
