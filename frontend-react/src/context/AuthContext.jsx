import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { clearStoredToken, getStoredToken, parseJwt, storeToken } from '../lib/auth.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => getStoredToken())
  const [user, setUser] = useState(() => parseJwt(getStoredToken()))

  const setToken = useCallback((nextToken) => {
    if (nextToken) {
      storeToken(nextToken)
      setTokenState(nextToken)
      setUser(parseJwt(nextToken))
      return
    }
    clearStoredToken()
    setTokenState(null)
    setUser(null)
  }, [])

  const logout = useCallback(() => setToken(null), [setToken])

  const value = useMemo(
    () => ({
      token,
      user,
      setToken,
      logout,
    }),
    [token, user, setToken, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return ctx
}
