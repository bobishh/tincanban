const palette = ["#e8c547", "#66b3ff", "#a98cff", "#65cf9b", "#ed8b65", "#e88bb8", "#62cbd3", "#b3ce67"]

export function columnColors(columns: readonly { id: string; color?: string }[]): Map<string, string> {
  const colors = new Map<string, string>()
  const used = new Set(columns.flatMap(column => column.color ? [column.color.toLowerCase()] : []))
  let index = 0
  for (const column of [...columns].sort((a, b) => a.id.localeCompare(b.id))) {
    if (column.color) { colors.set(column.id, column.color); continue }
    let color: string
    do {
      color = palette[index] ?? `hsl(${((index - palette.length) * 137.508) % 360} 65% 68%)`
      index++
    } while (used.has(color))
    used.add(color)
    colors.set(column.id, color)
  }
  return colors
}
