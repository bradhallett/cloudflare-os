import type { ReactNode } from 'react'

/** One titled card of admin settings, shared by the General and Access tab panels. */
export function SettingsCard({ title, description, children }: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
      <h2 className="text-lg font-semibold text-kumo-strong mb-1">{title}</h2>
      <p className="text-sm text-kumo-subtle mb-5">{description}</p>
      {children}
    </div>
  )
}
