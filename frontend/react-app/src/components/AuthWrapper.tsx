import { useSearchParams } from 'react-router-dom'
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { PasswordStrengthMeter } from './PasswordStrengthMeter'
import './AuthWrapper.css'

function SignUpFormFields() {
  const { formData } = useAuthenticator((context) => [context.formData])
  const password = formData?.password ?? ''

  return (
    <>
      <Authenticator.SignUp.FormFields />
      <div className="auth-password-strength-wrapper">
        <PasswordStrengthMeter password={password} />
      </div>
    </>
  )
}

const authComponents = {
  SignUp: {
    FormFields() {
      return <SignUpFormFields />
    },
  },
}

interface AuthWrapperProps {
  children: React.ReactNode
  socialProviders?: ('google' | 'amazon' | 'apple' | 'facebook')[]
  variation?: 'default' | 'modal'
}

export function AuthWrapper({ children, socialProviders = [], variation = 'modal' }: AuthWrapperProps) {
  const [searchParams] = useSearchParams()
  const initialState = searchParams.get('signup') === 'true' ? 'signUp' : 'signIn'

  return (
    <Authenticator
      variation={variation}
      initialState={initialState}
      loginMechanisms={['email']}
      socialProviders={socialProviders}
      components={authComponents}
      formFields={{
        signUp: {
          password: {
            label: 'Password',
            placeholder: 'Enter your password',
            isRequired: true,
            order: 2,
          },
          confirm_password: {
            label: 'Confirm Password',
            placeholder: 'Confirm your password',
            isRequired: true,
            order: 3,
          },
          email: {
            label: 'Email',
            placeholder: 'Enter your email',
            isRequired: true,
            order: 1,
          },
        },
        signIn: {
          username: {
            placeholder: 'Enter your email',
          },
          password: {
            placeholder: 'Enter your password',
          },
        },
      }}
    >
      {children}
    </Authenticator>
  )
}
