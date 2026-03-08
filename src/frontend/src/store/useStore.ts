import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AppState {
  // Auth
  isAuthenticated: boolean
  username:        string
  setAuth:         (authenticated: boolean, username?: string) => void

  // API keys (persisted locally — never sent to server as stored values)
  falKey:          string
  openrouterKey:   string
  setFalKey:       (key: string) => void
  setOpenrouterKey:(key: string) => void

  // Active project
  activeProjectId: string | null
  setActiveProject:(id: string | null) => void

  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      username:        '',
      setAuth: (authenticated, username = '') =>
        set({ isAuthenticated: authenticated, username }),

      falKey:          '',
      openrouterKey:   '',
      setFalKey:       (key) => set({ falKey: key }),
      setOpenrouterKey:(key) => set({ openrouterKey: key }),

      activeProjectId: null,
      setActiveProject:(id) => set({ activeProjectId: id }),

      sidebarOpen: true,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    }),
    {
      name:    'animatai-store',
      partialize: (s) => ({
        falKey:          s.falKey,
        openrouterKey:   s.openrouterKey,
        isAuthenticated: s.isAuthenticated,
        username:        s.username,
      }),
    },
  ),
)
