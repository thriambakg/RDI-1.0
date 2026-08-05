/**
 * Draggable / resizable floating window (Cosine ItemDetailsDialog pattern):
 * - During move/resize only a blue outline updates (no live window reflow).
 * - Drop near browser edges snaps like Windows: halves, quarters, maximize (top).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, IconButton, Paper, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'

export type WindowRect = { x: number; y: number; width: number; height: number }

export type SnapZone =
  | 'left'
  | 'right'
  | 'top'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'
  | null

const EDGE_PX = 28
const CORNER_PX = 56
const MIN_W = 420
const MIN_H = 360
const DEFAULT_W = 720
const DEFAULT_H = 640

export function detectSnapZone(clientX: number, clientY: number, vw: number, vh: number): SnapZone {
  const nearL = clientX <= CORNER_PX
  const nearR = clientX >= vw - CORNER_PX
  const nearT = clientY <= CORNER_PX
  const nearB = clientY >= vh - CORNER_PX
  // Corners win (Windows behavior)
  if (nearL && nearT) return 'topLeft'
  if (nearR && nearT) return 'topRight'
  if (nearL && nearB) return 'bottomLeft'
  if (nearR && nearB) return 'bottomRight'
  if (clientX <= EDGE_PX) return 'left'
  if (clientX >= vw - EDGE_PX) return 'right'
  if (clientY <= EDGE_PX) return 'top'
  return null
}

export function rectForSnap(zone: NonNullable<SnapZone>, vw: number, vh: number): WindowRect {
  const hw = Math.floor(vw / 2)
  const hh = Math.floor(vh / 2)
  switch (zone) {
    case 'left':
      return { x: 0, y: 0, width: hw, height: vh }
    case 'right':
      return { x: hw, y: 0, width: vw - hw, height: vh }
    case 'top':
      return { x: 0, y: 0, width: vw, height: vh }
    case 'topLeft':
      return { x: 0, y: 0, width: hw, height: hh }
    case 'topRight':
      return { x: hw, y: 0, width: vw - hw, height: hh }
    case 'bottomLeft':
      return { x: 0, y: hh, width: hw, height: vh - hh }
    case 'bottomRight':
      return { x: hw, y: hh, width: vw - hw, height: vh - hh }
  }
}

function clampFreeRect(r: WindowRect, vw: number, vh: number): WindowRect {
  const width = Math.max(MIN_W, Math.min(r.width, vw))
  const height = Math.max(MIN_H, Math.min(r.height, vh))
  const x = Math.max(0, Math.min(r.x, vw - Math.min(width, vw)))
  const y = Math.max(0, Math.min(r.y, vh - Math.min(height, vh)))
  return { x, y, width, height }
}

export type FloatingWindowProps = {
  open: boolean
  title: ReactNode
  titleExtra?: ReactNode
  onClose: () => void
  zIndex: number
  focused?: boolean
  onFocus?: () => void
  initialRect?: Partial<WindowRect>
  children: ReactNode
  footer?: ReactNode
}

export function FloatingWindow({
  open,
  title,
  titleExtra,
  onClose,
  zIndex,
  focused = false,
  onFocus,
  initialRect,
  children,
  footer,
}: FloatingWindowProps) {
  const [rect, setRect] = useState<WindowRect>(() =>
    clampFreeRect(
      {
        x: initialRect?.x ?? 80,
        y: initialRect?.y ?? 80,
        width: initialRect?.width ?? DEFAULT_W,
        height: initialRect?.height ?? DEFAULT_H,
      },
      typeof window !== 'undefined' ? window.innerWidth : 1280,
      typeof window !== 'undefined' ? window.innerHeight : 800,
    ),
  )
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)

  const previewRef = useRef<HTMLDivElement>(null)
  const previewRectRef = useRef<WindowRect>(rect)
  const snapZoneRef = useRef<SnapZone>(null)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0, originX: 0, originY: 0 })
  const rafIdRef = useRef<number | null>(null)
  const unsnappedSizeRef = useRef({ width: DEFAULT_W, height: DEFAULT_H })

  const paintPreview = useCallback((r: WindowRect) => {
    const el = previewRef.current
    if (!el) return
    el.style.display = 'block'
    el.style.left = `${r.x}px`
    el.style.top = `${r.y}px`
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
  }, [])

  const hidePreview = useCallback(() => {
    if (previewRef.current) previewRef.current.style.display = 'none'
  }, [])

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) return
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [data-no-drag]')) {
        return
      }
      e.preventDefault()
      onFocus?.()
      setIsDragging(true)
      dragOffsetRef.current = { x: e.clientX - rect.x, y: e.clientY - rect.y }
      // If currently snapped full/half, restore floating size for the outline while dragging
      const floating =
        rect.width >= window.innerWidth - 4 || rect.height >= window.innerHeight - 4
          ? {
              ...rect,
              width: unsnappedSizeRef.current.width,
              height: unsnappedSizeRef.current.height,
            }
          : rect
      if (rect.width < window.innerWidth - 8 && rect.height < window.innerHeight - 8) {
        unsnappedSizeRef.current = { width: rect.width, height: rect.height }
      }
      previewRectRef.current = {
        x: e.clientX - dragOffsetRef.current.x,
        y: e.clientY - dragOffsetRef.current.y,
        width: floating.width,
        height: floating.height,
      }
      snapZoneRef.current = null
      paintPreview(previewRectRef.current)
    },
    [isResizing, onFocus, paintPreview, rect],
  )

  const handleDragMove = useCallback(
    (e: MouseEvent) => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = requestAnimationFrame(() => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        const zone = detectSnapZone(e.clientX, e.clientY, vw, vh)
        snapZoneRef.current = zone
        if (zone) {
          const snapped = rectForSnap(zone, vw, vh)
          previewRectRef.current = snapped
          paintPreview(snapped)
          return
        }
        const w = unsnappedSizeRef.current.width
        const h = unsnappedSizeRef.current.height
        const x = e.clientX - dragOffsetRef.current.x
        const y = e.clientY - dragOffsetRef.current.y
        const next = clampFreeRect({ x, y, width: w, height: h }, vw, vh)
        previewRectRef.current = next
        paintPreview(next)
      })
    },
    [paintPreview],
  )

  const handleDragEnd = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    const next = previewRectRef.current
    if (
      next.width < window.innerWidth - 8 &&
      next.height < window.innerHeight - 8
    ) {
      unsnappedSizeRef.current = { width: next.width, height: next.height }
    }
    setRect(next)
    hidePreview()
    snapZoneRef.current = null
    setIsDragging(false)
  }, [hidePreview])

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) return
      e.preventDefault()
      e.stopPropagation()
      onFocus?.()
      setIsResizing(true)
      resizeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: rect.width,
        height: rect.height,
        originX: rect.x,
        originY: rect.y,
      }
      previewRectRef.current = { ...rect }
      paintPreview(rect)
    },
    [isDragging, onFocus, paintPreview, rect],
  )

  const handleResizeMove = useCallback(
    (e: MouseEvent) => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = requestAnimationFrame(() => {
        const s = resizeStartRef.current
        const vw = window.innerWidth
        const vh = window.innerHeight
        const width = Math.max(MIN_W, Math.min(vw - s.originX, s.width + (e.clientX - s.x)))
        const height = Math.max(MIN_H, Math.min(vh - s.originY, s.height + (e.clientY - s.y)))
        const next = { x: s.originX, y: s.originY, width, height }
        previewRectRef.current = next
        paintPreview(next)
      })
    },
    [paintPreview],
  )

  const handleResizeEnd = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    const next = previewRectRef.current
    unsnappedSizeRef.current = { width: next.width, height: next.height }
    setRect(next)
    hidePreview()
    setIsResizing(false)
  }, [hidePreview])

  useEffect(() => {
    if (!isDragging) return
    document.addEventListener('mousemove', handleDragMove)
    document.addEventListener('mouseup', handleDragEnd)
    document.body.style.cursor = 'move'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', handleDragMove)
      document.removeEventListener('mouseup', handleDragEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging, handleDragMove, handleDragEnd])

  useEffect(() => {
    if (!isResizing) return
    document.addEventListener('mousemove', handleResizeMove)
    document.addEventListener('mouseup', handleResizeEnd)
    document.body.style.cursor = 'nwse-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', handleResizeMove)
      document.removeEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, handleResizeMove, handleResizeEnd])

  if (!open) return null

  return (
    <>
      <Box
        ref={previewRef}
        sx={{
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          border: '2px solid #3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.12)',
          pointerEvents: 'none',
          zIndex: zIndex + 1,
          display: 'none',
          boxShadow: '0 0 12px rgba(59, 130, 246, 0.55)',
          borderRadius: '2px',
        }}
      />
      <Paper
        elevation={focused ? 12 : 6}
        onMouseDown={() => onFocus?.()}
        sx={{
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          zIndex,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: '#0b1220',
          border: focused ? '1px solid #38bdf8' : '1px solid #1e293b',
          borderRadius: '2px',
          backgroundImage:
            'radial-gradient(ellipse at top, rgba(56,189,248,0.08), transparent 55%), linear-gradient(#0b1220, #050a12)',
          color: '#f8fafc',
          pointerEvents: 'auto',
          opacity: isDragging || isResizing ? 0.35 : 1,
        }}
      >
        <Box
          data-title-bar
          onMouseDown={handleDragStart}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            px: 1.5,
            py: 1,
            borderBottom: '1px solid #1e293b',
            cursor: 'move',
            flexShrink: 0,
            backgroundColor: focused ? 'rgba(56,189,248,0.06)' : 'transparent',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0, flex: 1 }}>
            {typeof title === 'string' ? (
              <Typography
                component="span"
                sx={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: '#fff',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {title}
              </Typography>
            ) : (
              title
            )}
            {titleExtra}
          </Box>
          <IconButton
            size="small"
            aria-label="Close"
            data-no-drag
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            sx={{
              color: '#64748b',
              '&:hover': { color: '#f8fafc', backgroundColor: 'rgba(148,163,184,0.12)' },
            }}
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 2, py: 1.5 }}>{children}</Box>

        {footer != null && (
          <Box
            sx={{
              flexShrink: 0,
              borderTop: '1px solid #334155',
              p: 1.5,
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 1,
            }}
          >
            {footer}
          </Box>
        )}

        <Box
          onMouseDown={handleResizeStart}
          sx={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 16,
            height: 16,
            cursor: 'nwse-resize',
            background:
              'linear-gradient(135deg, transparent 50%, rgba(56,189,248,0.55) 50%)',
            zIndex: 2,
          }}
        />
      </Paper>
    </>
  )
}
