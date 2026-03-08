import { api, setAccessToken } from './client'

export async function login(email: string, password: string): Promise<void> {
  const { access_token } = await api<{ access_token: string }>('/auth/login', {
    method:  'POST',
    body:    JSON.stringify({ email, password }),
  })
  setAccessToken(access_token)
}

export async function register(email: string, username: string, password: string): Promise<void> {
  const { access_token } = await api<{ access_token: string }>('/auth/register', {
    method: 'POST',
    body:   JSON.stringify({ email, username, password }),
  })
  setAccessToken(access_token)
}

export async function verifyEmail(email: string, code: string): Promise<void> {
  const { access_token } = await api<{ access_token: string }>('/auth/verify', {
    method: 'POST',
    body:   JSON.stringify({ email, code }),
  })
  setAccessToken(access_token)
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' }).catch(() => {})
  setAccessToken(null)
}

export async function refreshToken(): Promise<boolean> {
  try {
    const { access_token } = await api<{ access_token: string }>('/auth/refresh', {
      method: 'POST',
    })
    setAccessToken(access_token)
    return true
  } catch {
    setAccessToken(null)
    return false
  }
}

export async function getMe() {
  return api<{ id: string; email: string; username: string }>('/auth/me')
}
