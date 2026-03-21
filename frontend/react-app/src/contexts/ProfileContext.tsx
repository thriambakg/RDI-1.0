/**
 * Profile context - caches connection hierarchy after login.
 * Avoids repeated API calls when flipping through folders/connections.
 */
import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { getProfile, type UserProfile, type ConnectionHierarchy, type RelayRef } from '../services/profileApi'

export interface ProfileContextType {
  profile: UserProfile | null
  hierarchy: ConnectionHierarchy
  isLoading: boolean
  error: string | null
  refetch: (opts?: { silent?: boolean }) => Promise<void>
  /** Apply an optimistic update to hierarchy; then refetch with silent to sync with backend. */
  updateHierarchy: (updater: (h: ConnectionHierarchy) => ConnectionHierarchy) => void
  /** Apply an optimistic update to relays array (e.g. status changes). */
  updateRelays: (updater: (relays: RelayRef[]) => RelayRef[]) => void
}

const ProfileContext = createContext<ProfileContextType | undefined>(undefined)

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hierarchy = profile?.connection_hierarchy ?? {}

  const fetchProfile = useCallback(async (opts?: { silent?: boolean }) => {
    if (!isAuthenticated) return
    if (!opts?.silent) {
      setIsLoading(true)
      setError(null)
    }
    try {
      const p = await getProfile()
      setProfile(p)
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load profile')
        setProfile(null)
      }
    } finally {
      if (!opts?.silent) setIsLoading(false)
    }
  }, [isAuthenticated])

  const updateHierarchy = useCallback((updater: (h: ConnectionHierarchy) => ConnectionHierarchy) => {
    setProfile((prev) =>
      prev ? { ...prev, connection_hierarchy: updater(prev.connection_hierarchy) } : null
    )
  }, [])

  const updateRelays = useCallback((updater: (relays: RelayRef[]) => RelayRef[]) => {
    setProfile((prev) =>
      prev ? { ...prev, relays: updater(prev.relays ?? []) } : null
    )
  }, [])

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
    updateHierarchy,
    updateRelays,
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
