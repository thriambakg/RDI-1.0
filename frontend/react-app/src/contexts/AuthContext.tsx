/**
 * Auth context - uses aws-amplify/auth APIs only (no Amplify UI).
 * Bearer token for API calls: fetchAuthSession() in sessionApi.ts - unchanged.
 */
import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  getCurrentUser,
  signIn,
  signUp,
  signOut,
  confirmSignUp,
  signInWithRedirect,
  fetchUserAttributes,
  type AuthUser,
} from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'

export interface RDIUser {
  id: string
  email: string
}

export interface AuthContextType {
  user: RDIUser | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>
  loginWithProvider: (provider: 'Google') => Promise<void>
  register: (email: string, password: string) => Promise<{ success: boolean; error?: string; verificationRequired?: boolean }>
  verifyEmail: (email: string, code: string) => Promise<{ success: boolean; error?: string }>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

async function convertCognitoUser(authUser: AuthUser): Promise<RDIUser | null> {
  try {
    const attrs = await fetchUserAttributes()
    const email = attrs.email || attrs.preferred_username || ''
    return { id: authUser.userId, email }
  } catch {
    return { id: authUser.userId, email: '' }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<RDIUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const isAuthenticated = !!user

  useEffect(() => {
    const init = async () => {
      try {
        const authUser = await getCurrentUser()
        const u = await convertCognitoUser(authUser)
        setUser(u)
      } catch {
        setUser(null)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [])

  useEffect(() => {
    const hubListener = Hub.listen('auth', async ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signInWithRedirect') {
        try {
          const authUser = await getCurrentUser()
          const u = await convertCognitoUser(authUser)
          setUser(u)
        } catch {
          setUser(null)
        }
      } else if (payload.event === 'signedOut') {
        setUser(null)
      }
    })
    return () => hubListener()
  }, [])

  const login = async (email: string, password: string) => {
    try {
      const result = await signIn({
        username: email.toLowerCase().trim(),
        password,
      })
      if (!result.isSignedIn) {
        if (result.nextStep?.signInStep === 'CONFIRM_SIGN_UP') {
          return { success: false, error: 'Please verify your email before signing in.' }
        }
        return { success: false, error: 'Sign-in not completed.' }
      }
      await new Promise((r) => setTimeout(r, 300))
      const authUser = await getCurrentUser()
      const u = await convertCognitoUser(authUser)
      setUser(u)
      return { success: true }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string }
      let msg = 'Login failed. Please try again.'
      if (e.name === 'NotAuthorizedException') msg = 'Incorrect email or password.'
      else if (e.name === 'UserNotConfirmedException') msg = 'Please verify your email before signing in.'
      else if (e.name === 'UserNotFoundException') msg = 'No account found with this email.'
      else if (e.message) msg = e.message
      return { success: false, error: msg }
    }
  }

  const loginWithProvider = async (provider: 'Google') => {
    await signInWithRedirect({ provider: provider as 'Google' })
  }

  const register = async (email: string, password: string) => {
    try {
      const username = email.toLowerCase().trim()
      await signUp({ username, password, options: { userAttributes: { email: username } } })
      return { success: true, verificationRequired: true }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string }
      let msg = 'Registration failed.'
      if (e.name === 'UsernameExistsException') msg = 'An account with this email already exists.'
      else if (e.message) msg = e.message
      return { success: false, error: msg }
    }
  }

  const verifyEmail = async (email: string, code: string) => {
    try {
      await confirmSignUp({ username: email.toLowerCase().trim(), confirmationCode: code.trim() })
      return { success: true }
    } catch (err: unknown) {
      const e = err as { message?: string }
      return { success: false, error: e.message || 'Verification failed.' }
    }
  }

  const logout = async () => {
    await signOut()
    setUser(null)
  }

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    login,
    loginWithProvider,
    register,
    verifyEmail,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
