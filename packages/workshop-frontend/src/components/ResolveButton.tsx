import { useButtonFeedback } from '@gadgets/ui'
import { Check } from '@phosphor-icons/react'

/**
 * Result of an approve/deny click the button reports as async feedback: a promise is tracked
 * through loading → success/error, a `false` result (sync or resolved) reports a failure whose own
 * reporting (error toast) already happened, and returning nothing means no feedback (the click
 * opened a dialog instead of starting the decision).
 */
export type ResolveClickResult = boolean | PromiseLike<boolean | void> | void

function FeedbackSpinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent ${className}`}
    />
  )
}

export function ResolveButton({
  tone,
  variant = 'quiet',
  disabled,
  onClick,
  describedBy,
}: {
  tone: 'approve' | 'deny'
  variant?: 'quiet' | 'filled'
  disabled: boolean
  onClick: () => ResolveClickResult
  /**
   * Ids of the review text this decision rests on (the restricted-mode notice and the request),
   * so screen readers announce it on focus even though it follows the button in DOM order.
   */
  describedBy?: string
}) {
  const feedback = useButtonFeedback()
  const { status, ...holdProps } = feedback.buttonProps
  const idleLabel = tone === 'approve' ? 'Approve' : 'Deny'
  const label =
    status === 'success' ? (tone === 'approve' ? 'Approved' : 'Denied') : idleLabel
  const toneClassName =
    status === 'error'
      ? 'h-6 px-2 text-kumo-danger'
      : status === 'success'
        ? 'h-6 px-2 text-kumo-success'
        : variant === 'filled'
          ? 'h-7 bg-kumo-brand px-3 text-white enabled:hover:opacity-90'
          : tone === 'approve'
            ? 'h-6 px-2 text-kumo-default enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default-hover'
            : 'h-6 px-2 text-kumo-inactive enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger'

  return (
    <button
      type="button"
      {...holdProps}
      onClick={() => {
        feedback.trackBoolean(onClick())
      }}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-busy={status === 'loading' || undefined}
      data-feedback={status}
      className={`flex cursor-pointer items-center gap-1 rounded-md text-[12px] font-medium tracking-[-0.15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClassName}`}
    >
      {status === 'loading' && <FeedbackSpinner />}
      {status === 'success' && <Check size={12} weight="bold" aria-hidden="true" />}
      {status === 'error' ? `${idleLabel} failed` : label}
    </button>
  )
}

export function AlwaysApproveButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
    >
      Always approve
    </button>
  )
}

export { FeedbackSpinner }
