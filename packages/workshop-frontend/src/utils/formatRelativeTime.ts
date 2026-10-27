/**
 * Options for {@link formatRelativeTime}.
 */
export interface FormatRelativeTimeOptions {
  /**
   * How fine to measure age: whole minutes (lists, activity) or seconds (surfaces where a
   * just-created thing must read as fresh, like share links).
   */
  precision?: 'minute' | 'second'
  /**
   * Past a week, render the calendar date instead of a day count (share links read as points in
   * time, not ages).
   */
  beyondCutoffDate?: boolean
}

/**
 * "3m ago"-style age for a timestamp, floored and clamped so clock skew never yields "-2m ago".
 */
export function formatRelativeTime(date: Date, options: FormatRelativeTimeOptions = {}): string {
  const { precision = 'minute', beyondCutoffDate = false } = options
  const ms = Math.max(0, Date.now() - date.getTime())

  let days: number
  if (precision === 'second') {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    days = Math.floor(hours / 24)
  } else {
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 1) return 'just now'
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    days = Math.floor(hours / 24)
  }

  if (beyondCutoffDate && days >= 7) return date.toLocaleDateString()
  return `${days}d ago`
}
