import { onBeforeUnmount, onMounted, ref } from "vue"
import type { PublicItem, PublicColumn } from "./publicBoardView"
import type { PublicBoardProjection } from "./publicSchema"

type PublicCardAgingPolicy = NonNullable<PublicBoardProjection["board"]["presentation"]>["cardAgingPolicy"]

export function usePublicCardAges(policy: () => PublicCardAgingPolicy) {
  const now = ref(new Date())
  let interval: ReturnType<typeof setInterval> | undefined
  onMounted(() => { interval = setInterval(() => { now.value = new Date() }, 60_000) })
  onBeforeUnmount(() => { if (interval) clearInterval(interval) })
  return (item: PublicItem, column: PublicColumn) => {
    if (/^(done|complete|completed)$/i.test(column.title.trim())) return null
    const activity = new Date(item.lastActivityAt ?? item.updatedAt)
    if (Number.isNaN(activity.getTime()) || Number.isNaN(now.value.getTime())) return null
    const days = Math.max(0, Math.floor((now.value.getTime() - activity.getTime()) / 86_400_000))
    const thresholds = policy()?.thresholds ?? { watch: 7, aged: 14, overdue: 30 }
    const level = days >= thresholds.overdue ? "overdue" : days >= thresholds.aged ? "aged" : days >= thresholds.watch ? "watch" : "fresh"
    const duration = `${days} ${days === 1 ? "day" : "days"}`
    return { days, level, label: item.lastActivityAt ? `No activity for ${duration}` : `Last updated ${duration} ago` }
  }
}
