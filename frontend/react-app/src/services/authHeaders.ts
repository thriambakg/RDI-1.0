/**
 * Shared auth headers for API calls. Uses Amplify fetchAuthSession;
 * retries with forceRefresh when session has no tokens (e.g. after OAuth redirect).
 * Only logs a warning when no token is available (401 likely).
 */
import { fetchAuthSession } from 'aws-amplify/auth'

const log = typeof window !== 'undefined'

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  let session = await fetchAuthSession()
  let idToken = session.tokens?.idToken
  let accessToken = session.tokens?.accessToken


  let token: unknown = idToken ?? accessToken
  const hasUsableToken = token != null && typeof (token as { toString?: () => string }).toString === 'function'

  if (!hasUsableToken) {
    try {
      session = await fetchAuthSession({ forceRefresh: true })
      idToken = session.tokens?.idToken
      accessToken = session.tokens?.accessToken
      token = idToken ?? accessToken
    } catch (e) {
      if (log) console.warn('[RDI Auth] fetchAuthSession(forceRefresh) failed:', e)
    }
  }

  let bearer = ''
  if (token != null) {
    const t = token as { toString?: () => string; tokenString?: string }
    if (typeof t.toString === 'function') {
      bearer = t.toString()
    } else if (typeof token === 'string') {
      bearer = token
    } else if (typeof t.tokenString === 'string') {
      bearer = t.tokenString
    }
  }

  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`
  } else {
    if (log) {
      console.warn(
        '🔒 [RDI Auth] No Cognito token; request will likely get 401. Ensure you are signed in and Amplify uses the same User Pool as the API.'
      )
    }
  }

  return headers
}
