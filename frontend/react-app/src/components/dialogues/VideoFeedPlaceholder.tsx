import './VideoFeedPlaceholder.css'

export type VideoFeedPlaceholderProps = {
  /** Compact corner for mobile full-bleed; roomier for desktop window */
  variant?: 'desktop' | 'mobile'
  className?: string
}

/** Shared camera / CV stage placeholder until a real video track is wired. */
export function VideoFeedPlaceholder({ variant = 'desktop', className }: VideoFeedPlaceholderProps) {
  return (
    <div
      className={`rdi-video-feed rdi-video-feed--${variant}${className ? ` ${className}` : ''}`}
      aria-label="Video feed"
    >
      <div className="rdi-video-feed-placeholder">
        <strong>Video feed</strong>
        <span>Camera placeholder — stream / CV will render here</span>
      </div>
    </div>
  )
}
