import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react'
import { PasswordStrengthMeter } from './PasswordStrengthMeter'

export function SignUpFormFields() {
  const ctx = useAuthenticator() as { formData?: { password?: string } }
  const password = ctx.formData?.password ?? ''

  return (
    <>
      <Authenticator.SignUp.FormFields />
      <div className="auth-password-strength-wrapper">
        <PasswordStrengthMeter password={password} />
      </div>
    </>
  )
}
