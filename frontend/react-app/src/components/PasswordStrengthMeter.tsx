import { useMemo } from 'react'
import './PasswordStrengthMeter.css'

function scorePassword(password: string): { score: number; label: string } {
  if (!password || password.length === 0) {
    return { score: 0, label: '' }
  }
  let score = 0
  if (password.length >= 8) score += 1
  if (password.length >= 12) score += 1
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1
  if (/\d/.test(password)) score += 1
  if (/[^a-zA-Z0-9]/.test(password)) score += 1

  if (score <= 1) return { score: 1, label: 'Weak' }
  if (score <= 2) return { score: 2, label: 'Fair' }
  if (score <= 3) return { score: 3, label: 'Good' }
  return { score: 4, label: 'Strong' }
}

interface PasswordStrengthMeterProps {
  password: string
}

export function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  const { score, label } = useMemo(() => scorePassword(password ?? ''), [password])

  if (!password || password.length === 0) return null

  return (
    <div className="password-strength" role="status" aria-live="polite">
      <div className="password-strength__bars">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`password-strength__bar ${i <= score ? `password-strength__bar--${score}` : ''}`}
          />
        ))}
      </div>
      <span className={`password-strength__label password-strength__label--${score}`}>
        {label}
      </span>
    </div>
  )
}
