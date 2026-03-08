const BASE = ''  // same-origin via Vite proxy

let accessToken: string | null = null

export function setAccessToken(token: string | null) {
  accessToken = token
}

export function getAccessToken() {
  return accessToken
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const resp = await fetch(`${BASE}${path}`, { ...init, headers })

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new ApiError(resp.status, body.detail ?? `HTTP ${resp.status}`)
  }

  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

/** Build headers with user-supplied API keys (stored in Zustand, sent per-request). */
export function apiWithKeys(falKey: string, openrouterKey: string): RequestInit['headers'] {
  return {
    'x-fal-key':         falKey,
    'x-openrouter-key':  openrouterKey,
  }
}
