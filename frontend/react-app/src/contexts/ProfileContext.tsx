/**
 * Profile context - caches connection hierarchy after login.
 * Avoids repeated API calls when flipping through folders/connections.
 */
import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { getProfile, type UserProfile, type ConnectionHierarchy } from '../services/profileApi'

export interface ProfileContextType {
  profile: UserProfile | null
  hierarchy: ConnectionHierarchy
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
}

const ProfileContext = createContext<ProfileContextType | undefined>(undefined)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hierarchy = profile?.connection_hierarchy ?? {}

  const fetchProfile = useCallback(async () => {
    if (!isAuthenticated) return
    setIsLoading(true)
    setError(null)
    try {
      const p = await getProfile()
      setProfile(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile')
      setProfile(null)
    } finally {
      setIsLoading(false)
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (isAuthenticated) {
      fetchProfile()
    } else {
      setProfile(null)
      setError(null)
    }
  }, [isAuthenticated, fetchProfile])

  const value: ProfileContextType = {
    profile,
    hierarchy,
    isLoading,
    error,
    refetch: fetchProfile,
  }

  return (
    <ProfileContext.Provider value={value}>
      {children}
    </ProfileContext.Provider>
  )
}

export function useProfile() {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider')
  return ctx
}
