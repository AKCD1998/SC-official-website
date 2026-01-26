export function parseJwt(token) {
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const json = atob(padded)
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function getStoredToken() {
  return localStorage.getItem('token')
}

export function storeToken(token) {
  localStorage.setItem('token', token)
}

export function clearStoredToken() {
  localStorage.removeItem('token')
}
