import { useState } from 'react'

/**
 * A round avatar: the person's photo, else their emoji, else the first letter of
 * their name. Decorative: the surrounding control or text names the person.
 * A photo fades in once it has loaded (instantly if it was already cached).
 */
export function UserAvatar({ name, emoji, imageUrl, size = 40, className = '' }: {
  name: string
  emoji?: string | null
  imageUrl?: string | null
  size?: number
  className?: string
}) {
  const initial = (Array.from(name.trim())[0] ?? '?').toUpperCase()
  return (
    <span aria-hidden="true" className={`user-avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * (imageUrl || !emoji ? 0.42 : 0.55)) }}>
      {imageUrl ? <FadeImage key={imageUrl} src={imageUrl} /> : emoji ? <span className="user-avatar__emoji">{emoji}</span> : initial}
    </span>
  )
}

function FadeImage({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img src={src} alt="" draggable={false} className={`m-img${loaded ? ' is-loaded' : ''}`}
      // Already decoded (cached): show at once, no fade.
      ref={(node) => { if (node?.complete && node.naturalWidth > 0 && !loaded) setLoaded(true) }}
      onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
  )
}
