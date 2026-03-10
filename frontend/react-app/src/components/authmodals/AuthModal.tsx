import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { SignUpFormFields } from './SignUpFormFields'
import './auth-modals.css'

export interface AuthModalProps {
  children: React.ReactNode
  socialProviders?: ('google' | 'amazon' | 'apple' | 'facebook')[]
  variation?: 'default' | 'modal'
  initialState?: 'signIn' | 'signUp'
}

/** Wraps content with Amplify Authenticator. Modal variation blurs the background. */
export function AuthModal({ children, socialProviders = [], variation = 'modal', initialState: initialStateProp }: AuthModalProps) {
  const [searchParams] = useSearchParams()
  const initialState =
    initialStateProp ??
    (searchParams.get('signup') === 'true' || searchParams.get('auth') === 'signup' ? 'signUp' : 'signIn')

  useEffect(() => {
    if (typeof window !== 'undefined') {
      console.log('[RDI Auth] AuthModal mounted', { variation, initialState, socialProviders, socialCount: socialProviders.length })
      const t = setTimeout(() => {
        const el = document.querySelector('[data-amplify-authenticator][data-variation="modal"]')
        const styles = el ? getComputedStyle(el) : null
        console.log('[RDI Auth] Modal DOM check', {
          found: !!el,
          backdropFilter: styles?.backdropFilter || styles?.getPropertyValue('-webkit-backdrop-filter'),
          backgroundColor: styles?.backgroundColor,
        })
      }, 500)
      return () => clearTimeout(t)
    }
  }, [variation, initialState, socialProviders])

  return (
    <Authenticator
      variation={variation}
      initialState={initialState}
      loginMechanisms={['email']}
      socialProviders={socialProviders}
      components={{
        SignUp: {
          FormFields: SignUpFormFields,
        },
      }}
      formFields={{
        signUp: {
          password: { label: 'Password', placeholder: 'Enter your password', isRequired: true, order: 2 },
          confirm_password: { label: 'Confirm Password', placeholder: 'Confirm your password', isRequired: true, order: 3 },
          email: { label: 'Email', placeholder: 'Enter your email', isRequired: true, order: 1 },
        },
        signIn: {
          username: { placeholder: 'Enter your email' },
          password: { placeholder: 'Enter your password' },
        },
      }}
    >
      {children}
    </Authenticator>
  )
}
