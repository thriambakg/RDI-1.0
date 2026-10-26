/**
 * Auth context - aws-amplify/auth.
 * Email/password: Cognito required TOTP MFA every sign-in.
 * Google (federated): IdP owns auth + MFA — no extra app TOTP after OAuth.
 * Email signup: Cognito email verification link (VerifyEmailForm).
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  getCurrentUser,
  signIn,
  signUp,
  signOut,
  confirmSignUp,
  confirmSignIn,
  signInWithRedirect,
  fetchUserAttributes,
  updateMFAPreference,
  type AuthUser,
  type SignInOutput,
} from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import { releaseAuthSession } from '../services/profileApi'
import { notifyTransportTeardown, SESSION_SUPERSEDED_EVENT } from '../services/sessionGuard'

export interface RDIUser {
  id: string
  email: string
}

export type MfaPending =
  | { kind: 'setup'; setupUri: string; sharedSecret: string; source: 'cognito' }
  | { kind: 'confirm'; source: 'cognito' }

export interface AuthContextType {
  user: RDIUser | null
  isLoading: boolean
  isAuthenticated: boolean
  /** True when Cognito session exists AND any required MFA gate is satisfied. */
  canAccessApp: boolean
  mfaPending: MfaPending | null
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; mfa?: boolean }>
  confirmMfa: (code: string) => Promise<{ success: boolean; error?: string; mfa?: boolean }>
  cancelMfa: () => Promise<void>
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

function loginErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string }
  const raw = e.message || ''
  if (/already signed in/i.test(raw)) {
    return 'This account is already signed in on another device. Sign out there first, or wait until that session goes idle (~15 min).'
  }
  if (e.name === 'NotAuthorizedException') return 'Incorrect email or password.'
  if (e.name === 'UserNotConfirmedException') return 'Please verify your email before signing in.'
  if (e.name === 'UserNotFoundException') return 'No account found with this email.'
  if (e.name === 'CodeMismatchException' || /code mismatch|invalid.*code/i.test(raw)) {
    return 'Invalid authenticator code. Try again.'
  }
  if (e.name === 'EnableSoftwareTokenMFAException') {
    return 'Could not verify authenticator. Check the code and try again.'
  }
  if (raw) return raw
  return 'Login failed. Please try again.'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<RDIUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null)

  const isAuthenticated = !!user
  const canEnter = isAuthenticated && !mfaPending

  const afterCognitoSignedIn = useCallback(async () => {
    const authUser = await getCurrentUser()
    const u = await convertCognitoUser(authUser)
    setUser(u)
    setMfaPending(null)
  }, [])

  useEffect(() => {
    const init = async () => {
      try {
        const authUser = await getCurrentUser()
        const u = await convertCognitoUser(authUser)
        setUser(u)
        setMfaPending(null)
      } catch {
        setUser(null)
      } finally {
        setIsLoading(false)
      }
    }
    void init()
  }, [])

  useEffect(() => {
    const hubListener = Hub.listen('auth', async ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signInWithRedirect') {
        try {
          await afterCognitoSignedIn()
        } catch {
          setUser(null)
        }
      } else if (payload.event === 'signedOut') {
        setUser(null)
        setMfaPending(null)
      } else if (payload.event === 'tokenRefresh_failure' || payload.event === 'signInWithRedirect_failure') {
        try {
          await signOut()
        } catch {
          /* ignore */
        }
        setUser(null)
        setMfaPending(null)
      }
    })
    return () => hubListener()
  }, [afterCognitoSignedIn])

  useEffect(() => {
    const onSuperseded = () => {
      void (async () => {
        try {
          await signOut()
        } catch {
          /* ignore */
        }
        setUser(null)
        setMfaPending(null)
      })()
    }
    window.addEventListener(SESSION_SUPERSEDED_EVENT, onSuperseded)
    return () => window.removeEventListener(SESSION_SUPERSEDED_EVENT, onSuperseded)
  }, [])

  const finishCognitoSignedIn = async () => {
    await new Promise((r) => setTimeout(r, 300))
    try {
      await updateMFAPreference({ totp: 'PREFERRED' })
    } catch {
      /* ignore */
    }
    await afterCognitoSignedIn()
  }

  const applySignInStep = async (
    result: SignInOutput
  ): Promise<{ success: boolean; error?: string; mfa?: boolean }> => {
    if (result.isSignedIn) {
      await finishCognitoSignedIn()
      return { success: true }
    }

    const step = result.nextStep?.signInStep

    if (step === 'CONFIRM_SIGN_UP') {
      return { success: false, error: 'Please verify your email before signing in.' }
    }

    if (step === 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION') {
      return applySignInStep(await confirmSignIn({ challengeResponse: 'TOTP' }))
    }

    if (step === 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION') {
      return applySignInStep(await confirmSignIn({ challengeResponse: 'TOTP' }))
    }

    if (step === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
      const details =
        result.nextStep && 'totpSetupDetails' in result.nextStep
          ? result.nextStep.totpSetupDetails
          : null
      if (!details) {
        return { success: false, error: 'Could not start authenticator setup.' }
      }
      setMfaPending({
        kind: 'setup',
        setupUri: details.getSetupUri('RDI').toString(),
        sharedSecret: details.sharedSecret,
        source: 'cognito',
      })
      return { success: false, mfa: true }
    }

    if (step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
      setMfaPending({ kind: 'confirm', source: 'cognito' })
      return { success: false, mfa: true }
    }

    return { success: false, error: 'Sign-in not completed.' }
  }

  const login = async (email: string, password: string) => {
    try {
      setMfaPending(null)
      const result = await signIn({
        username: email.toLowerCase().trim(),
        password,
      })
      return await applySignInStep(result)
    } catch (err: unknown) {
      setMfaPending(null)
      return { success: false, error: loginErrorMessage(err) }
    }
  }

  const confirmMfa = async (code: string) => {
    const trimmed = code.replace(/\s/g, '')
    if (!mfaPending) {
      return { success: false, error: 'No MFA challenge pending.' }
    }
    try {
      const result = await confirmSignIn({ challengeResponse: trimmed })
      return await applySignInStep(result)
    } catch (err: unknown) {
      return { success: false, error: loginErrorMessage(err) }
    }
  }

  const cancelMfa = async () => {
    setMfaPending(null)
    try {
      await signOut()
    } catch {
      /* ignore */
    }
    setUser(null)
  }

  const loginWithProvider = async (provider: 'Google') => {
    try {
      // Clear a stale Cognito session so Hosted UI / Google can start cleanly.
      await signOut({ global: false })
    } catch {
      /* not signed in */
    }
    await signInWithRedirect({ provider })
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
    notifyTransportTeardown()
    try {
      await releaseAuthSession()
    } catch {
      /* ignore */
    }
    await signOut()
    setUser(null)
    setMfaPending(null)
  }

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    canAccessApp: canEnter,
    mfaPending,
    login,
    confirmMfa,
    cancelMfa,
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
