import type { LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'

interface IconButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  variant?: 'ghost' | 'danger'
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  variant = 'ghost'
}: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={`icon-button ${variant === 'danger' ? 'icon-button-danger' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon size={16} />
    </button>
  )
}
