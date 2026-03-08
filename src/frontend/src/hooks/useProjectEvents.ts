import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ProjectEvent } from '../types'
import { getAccessToken } from '../api/client'

/**
 * Subscribe to SSE events for a project and invalidate React Query caches
 * so the UI re-fetches automatically on each event.
 */
export function useProjectEvents(projectId: string | null) {
  const queryClient = useQueryClient()
  const esRef       = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!projectId) return

    const token = getAccessToken()
    // EventSource doesn't support custom headers — pass token as query param
    const url = `/api/events/${projectId}?token=${token ?? ''}`
    const es  = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as ProjectEvent
        console.log('[SSE]', payload.event, payload.data)

        // Invalidate project query on every meaningful event
        queryClient.invalidateQueries({ queryKey: ['project', projectId] })
        queryClient.invalidateQueries({ queryKey: ['projects'] })

      } catch { /* ignore malformed events */ }
    }

    es.onerror = () => {
      // Browser reconnects automatically; log for debugging
      console.warn('[SSE] Connection error — browser will retry')
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [projectId, queryClient])
}
