import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { useStore } from '../store/useStore'
import { listProjects } from '../api/projects'
import { logout } from '../api/auth'
import type { Project } from '../types'
import ProjectView from './ProjectView'
import CreateView  from './CreateView'
import ApiKeysModal from './ApiKeysModal'

type Canvas = 'welcome' | 'create' | 'project'

interface Props { onLogout: () => void }

export default function AppLayout({ onLogout }: Props) {
  const { sidebarOpen, toggleSidebar, username } = useStore()
  const { activeProjectId, setActiveProject }    = useStore()
  const [canvas, setCanvas] = useState<Canvas>('welcome')
  const [showApiKeys, setShowApiKeys] = useState(false)

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn:  listProjects,
  })

  async function handleLogout() {
    await logout()
    onLogout()
  }

  function openProject(id: string) {
    setActiveProject(id)
    setCanvas('project')
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}
    >
      {/* Sidebar */}
      <motion.aside
        animate={{ width: sidebarOpen ? 260 : 60 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        style={{
          flexShrink:   0,
          background:   'var(--bg-card)',
          borderRight:  '1px solid var(--border)',
          display:      'flex',
          flexDirection:'column',
          overflow:     'hidden',
        }}
      >
        {/* Toggle */}
        <button
          onClick={toggleSidebar}
          style={{ padding: '18px 20px', color: 'var(--text-muted)', fontSize: 18, textAlign: 'left' }}
        >
          {sidebarOpen ? '←' : '→'}
        </button>

        <motion.div
          animate={{ opacity: sidebarOpen ? 1 : 0, pointerEvents: sidebarOpen ? 'auto' : 'none' }}
          transition={{ duration: 0.15 }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 12px 12px' }}
        >
          {/* Brand */}
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--accent)', padding: '0 8px 20px' }}>
            AnimatAI
          </div>

          {/* New project button */}
          <button
            onClick={() => setCanvas('create')}
            style={{
              background: 'var(--accent)', color: 'var(--text-card)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              fontWeight: 700, fontSize: 13, marginBottom: 20,
            }}
          >
            + Новый мультфильм
          </button>

          {/* Projects list */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {projects.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 8px' }}>
                Нет мультфильмов
              </p>
            ) : projects.map((p) => (
              <button
                key={p.id}
                onClick={() => openProject(p.id)}
                style={{
                  textAlign:    'left',
                  padding:      '9px 10px',
                  borderRadius: 'var(--radius)',
                  fontSize:     13,
                  color:        activeProjectId === p.id ? 'var(--accent)' : 'var(--text)',
                  background:   activeProjectId === p.id ? 'var(--bg-hover)' : 'transparent',
                  fontWeight:   activeProjectId === p.id ? 600 : 400,
                  whiteSpace:   'nowrap',
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.name ?? p.scenario.slice(0, 28) + '…'}
              </button>
            ))}
          </div>

          {/* Footer */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 8 }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, padding: '0 8px' }}>
              {username}
            </p>
            <button
              onClick={() => setShowApiKeys(true)}
              style={{ color: 'var(--accent)', fontSize: 12, padding: '4px 8px', display: 'block', marginBottom: 4 }}
            >
              API ключи
            </button>
            <button
              onClick={handleLogout}
              style={{ color: 'var(--text-muted)', fontSize: 12, padding: '4px 8px' }}
            >
              Выйти
            </button>
          </div>
        </motion.div>
      </motion.aside>

      {/* API Keys modal */}
      {showApiKeys && <ApiKeysModal onClose={() => setShowApiKeys(false)} />}

      {/* Main canvas */}
      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <AnimatePresence mode="wait">
          {canvas === 'welcome' && (
            <WelcomeScreen key="welcome" onCreate={() => setCanvas('create')} />
          )}
          {canvas === 'create' && (
            <CreateView
              key="create"
              onCancel={() => setCanvas('welcome')}
              onCreated={(id) => openProject(id)}
            />
          )}
          {canvas === 'project' && activeProjectId && (
            <ProjectView
              key={`project-${activeProjectId}`}
              projectId={activeProjectId}
              onDelete={() => { setActiveProject(null); setCanvas('welcome') }}
            />
          )}
        </AnimatePresence>
      </main>
    </motion.div>
  )
}

function WelcomeScreen({ onCreate }: { onCreate: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 24, padding: 32,
      }}
    >
      <h2 style={{ fontSize: 'clamp(24px, 3vw, 40px)', fontWeight: 800, textAlign: 'center' }}>
        Создай свой мультфильм
      </h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: 400, textAlign: 'center' }}>
        Опиши историю — ИИ разобьёт её на сцены, нарисует кадры и склеит видео.
      </p>
      <motion.button
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        onClick={onCreate}
        style={{
          background: 'var(--accent)', color: 'var(--text-card)',
          borderRadius: 'var(--radius-pill)', padding: '14px 44px',
          fontSize: 15, fontWeight: 800,
          boxShadow: '0 7px 0 #7a9a00, 0 10px 24px rgba(0,0,0,.45)',
        }}
      >
        Создать мультфильм
      </motion.button>
    </motion.div>
  )
}
