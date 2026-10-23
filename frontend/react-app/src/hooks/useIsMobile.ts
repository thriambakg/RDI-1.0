import { useEffect, useState } from 'react'

const MOBILE_MQ = '(max-width: 900px) and (pointer: coarse), (max-width: 600px)'

function detectMobile(): boolean {
  if (typeof window === 'undefined') return false
  const ua = navigator.userAgent || ''
  const uaPhone = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)
  const mq = window.matchMedia(MOBILE_MQ).matches
  const touchPhone =
    navigator.maxTouchPoints > 1 &&
    Math.min(window.screen.width, window.screen.height) <= 520
  return uaPhone || mq || touchPhone
}

/** True when the UI should use the phone / touch layout. Re-renders on resize / orientation. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(detectMobile)

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ)
    const refresh = () => setMobile(detectMobile())
    mq.addEventListener('change', refresh)
    window.addEventListener('resize', refresh)
    window.addEventListener('orientationchange', refresh)
    refresh()
    return () => {
      mq.removeEventListener('change', refresh)
      window.removeEventListener('resize', refresh)
      window.removeEventListener('orientationchange', refresh)
    }
  }, [])

  return mobile
}

const LANDSCAPE_MQ = '(orientation: landscape)'

/** True when the viewport is landscape (used for mobile flight pad). */
export function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(LANDSCAPE_MQ).matches : true,
  )

  useEffect(() => {
    const mq = window.matchMedia(LANDSCAPE_MQ)
    const refresh = () => setLandscape(mq.matches)
    mq.addEventListener('change', refresh)
    window.addEventListener('orientationchange', refresh)
    refresh()
    return () => {
      mq.removeEventListener('change', refresh)
      window.removeEventListener('orientationchange', refresh)
    }
  }, [])

  return landscape
}
