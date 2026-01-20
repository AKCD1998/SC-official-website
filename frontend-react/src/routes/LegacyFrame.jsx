const DEFAULT_LEGACY_BASE = 'http://localhost:5500'

export default function LegacyFrame({ path }) {
  const baseUrl = import.meta.env.VITE_LEGACY_BASE_URL || DEFAULT_LEGACY_BASE
  const src = `${baseUrl}${path}`

  return (
    <iframe
      title="Legacy Page"
      src={src}
      style={{ width: '100%', height: '100vh', border: 'none' }}
    />
  )
}
