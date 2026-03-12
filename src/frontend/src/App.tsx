import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from './store/useStore'
import { refreshToken } from './api/auth'

// ── Views (lazy-loaded to keep initial bundle small) ─────────────────────────
import LandingView   from './components/LandingView'
import LoginView     from './components/LoginView'
import RegisterView  from './components/RegisterView'
import AppLayout     from './components/AppLayout'

type View = 'landing' | 'login' | 'register' | 'app'

export default function App() {
  const { isAuthenticated, setAuth } = useStore()
  const [view, setView] = useState<View>('landing')
  const [booting, setBooting] = useState(true)

  // Attempt silent token refresh on mount
  useEffect(() => {
    if (isAuthenticated) {
      refreshToken()
        .then((ok) => {
          if (ok) setView('app')
          else { setAuth(false); setView('landing') }
        })
        .finally(() => setBooting(false))
    } else {
      setBooting(false)
    }
  }, [])   // eslint-disable-line

  if (booting) {
    return (
      <div style={{ display: 'flex', height: '100dvh', alignItems: 'center', justifyContent: 'center' }}>
        <motion.div
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.4, repeat: Infinity }}
          style={{ color: 'var(--accent)', fontSize: 32, fontWeight: 700, letterSpacing: '0.1em' }}
        >
          OH_MY_TOON
        </motion.div>
      </div>
    )
  }

  return (
    <AnimatePresence mode="wait">
      {view === 'landing'  && <LandingView  key="landing"  onLogin={() => setView('login')} onRegister={() => setView('register')} />}
      {view === 'login'    && <LoginView    key="login"    onSuccess={() => setView('app')} onBack={() => setView('landing')} onRegister={() => setView('register')} />}
      {view === 'register' && <RegisterView key="register" onSuccess={() => setView('login')} onBack={() => setView('landing')} />}
      {view === 'app'      && <AppLayout    key="app"      onLogout={() => { setAuth(false); setView('landing') }} />}
    </AnimatePresence>
  )
}
