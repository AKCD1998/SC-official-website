const rawBase =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE ||
  ''
const API_BASE = rawBase.trim().endsWith('/') ? rawBase.trim().slice(0, -1) : rawBase.trim()

export function apiUrl(path) {
  if (!path.startsWith('/')) return `${API_BASE}/${path}`
  return `${API_BASE}${path}`
}

export async function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), options)
}
