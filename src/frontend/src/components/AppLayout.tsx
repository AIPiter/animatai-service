import { useState, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useStore } from '../store/useStore'
import { listProjects, deleteProject } from '../api/projects'
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
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)

  const qc = useQueryClient()
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn:  listProjects,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      if (deleteTarget && activeProjectId === deleteTarget.id) {
        setActiveProject(null)
        setCanvas('welcome')
      }
      setDeleteTarget(null)
    },
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
      <AnimatePresence>
        {sidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 260, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            style={{
              flexShrink:    0,
              background:    'var(--bg-card)',
              borderRight:   '1px solid var(--border)',
              display:       'flex',
              flexDirection: 'column',
              overflow:      'hidden',
            }}
          >
            {/* Top area: new project + collapse */}
            <div style={{ padding: '16px 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setCanvas('create')}
                  style={{
                    flex: 1,
                    background: 'var(--accent)', color: 'var(--text-card)',
                    borderRadius: 'var(--radius)', padding: '12px 14px',
                    fontWeight: 800, fontSize: 13,
                    boxShadow: '0 4px 0 #7a9a00',
                  }}
                >
                  + Новый мультфильм
                </motion.button>
                <button
                  onClick={toggleSidebar}
                  title="Скрыть меню"
                  style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: 'var(--bg-hover)', color: 'var(--text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, flexShrink: 0,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Projects list */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px' }}>
              {projects.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 8px' }}>
                  Нет мультфильмов
                </p>
              ) : projects.map((p) => (
                <ProjectItem
                  key={p.id}
                  project={p}
                  active={activeProjectId === p.id}
                  onClick={() => openProject(p.id)}
                  onDelete={() => setDeleteTarget(p)}
                />
              ))}
            </div>

            {/* Footer */}
            <div style={{ borderTop: '1px solid var(--border)', padding: '12px 12px' }}>
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
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Collapsed sidebar toggle */}
      {!sidebarOpen && (
        <motion.button
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          onClick={toggleSidebar}
          title="Показать меню"
          style={{
            position: 'fixed', top: 16, left: 16, zIndex: 50,
            width: 40, height: 40, borderRadius: 10,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            color: 'var(--text-muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            cursor: 'pointer',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </motion.button>
      )}

      {/* API Keys modal */}
      {showApiKeys && <ApiKeysModal onClose={() => setShowApiKeys(false)} />}

      {/* Delete confirmation modal */}
      <AnimatePresence>
        {deleteTarget && (
          <DeleteModal
            projectName={deleteTarget.name ?? deleteTarget.scenario.slice(0, 30)}
            loading={deleteMut.isPending}
            onConfirm={() => deleteMut.mutate(deleteTarget.id)}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
      </AnimatePresence>

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


/* -- Project item in sidebar with three-dot menu --------------------------- */

function ProjectItem({ project, active, onClick, onDelete }: {
  project: Project; active: boolean; onClick: () => void; onDelete: () => void
}) {
  const [hover, setHover]     = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false) }}
    >
      <button
        onClick={onClick}
        style={{
          width: '100%', textAlign: 'left',
          padding: '9px 10px', paddingRight: 32,
          borderRadius: 'var(--radius)',
          fontSize: 13,
          color:      active ? 'var(--accent)' : 'var(--text)',
          background: active ? 'var(--bg-hover)' : 'transparent',
          fontWeight: active ? 600 : 400,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {project.name ?? project.scenario.slice(0, 28) + '...'}
      </button>

      {/* Three-dot button */}
      {(hover || menuOpen) && (
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            width: 24, height: 24, borderRadius: 4,
            background: 'var(--bg-hover)', color: 'var(--text-muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14,
          }}
        >
          ...
        </button>
      )}

      {/* Dropdown menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: 'absolute', right: 0, top: '100%', zIndex: 100,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 4, minWidth: 140,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete() }}
            style={{
              width: '100%', textAlign: 'left', padding: '8px 12px',
              borderRadius: 6, fontSize: 12, color: '#f55',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
            Удалить
          </button>
        </div>
      )}
    </div>
  )
}


/* -- Delete confirmation modal --------------------------------------------- */

function DeleteModal({ projectName, loading, onConfirm, onCancel }: {
  projectName: string; loading: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        style={{
          background: 'var(--bg-card)', borderRadius: 16,
          padding: 32, maxWidth: 400, width: '90%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          border: '1px solid var(--border)',
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          Удалить проект?
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, marginBottom: 24 }}>
          Проект "{projectName}" будет удален безвозвратно вместе со всеми кадрами и видео.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 20px', borderRadius: 8,
              border: '1px solid var(--border)', color: 'var(--text)',
              fontSize: 13, fontWeight: 600,
            }}
          >
            Отмена
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            style={{
              padding: '8px 20px', borderRadius: 8,
              background: '#f55', color: '#fff',
              fontSize: 13, fontWeight: 700,
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '...' : 'Удалить'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}


/* -- Welcome screen -------------------------------------------------------- */

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
        Опиши историю — ИИ разобьет её на сцены, нарисует кадры и склеит видео.
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
