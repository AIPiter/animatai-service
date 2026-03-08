import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProject, startVideoGeneration, renderProject,
  deleteProject, updateScene, regenerateSceneImage, regenerateSceneVideo,
} from '../api/projects'
import { useProjectEvents } from '../hooks/useProjectEvents'
import type { Scene, ProjectStatus } from '../types'

interface Props {
  projectId: string
  onDelete:  () => void
}

const STATUS_RU: Record<ProjectStatus, string> = {
  created:           'Разбивка сценария...',
  scenes_ready:      'Сцены готовы',
  generating:        'Генерация изображений...',
  done:              'Изображения готовы',
  generating_videos: 'Генерация видео...',
  videos_ready:      'Видео готовы',
  rendering:         'Сборка финального видео...',
  rendered:          'Готово',
  error:             'Ошибка',
}

const TRANSITIONS = ['CUT', 'FADE'] as const

export default function ProjectView({ projectId, onDelete }: Props) {
  const qc = useQueryClient()
  useProjectEvents(projectId)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn:  () => getProject(projectId),
    refetchInterval: 8000,
  })

  const genVideos = useMutation({ mutationFn: () => startVideoGeneration(projectId), onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }) })
  const render    = useMutation({ mutationFn: () => renderProject(projectId),        onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }) })
  const deleteMut = useMutation({ mutationFn: () => deleteProject(projectId),        onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); onDelete() } })

  if (isLoading) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Загрузка...</div>
  if (!project)  return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Проект не найден</div>

  const scenes = project.scenes ?? []
  const status = project.status

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', height: 64, borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em' }}>
            {project.name ?? project.scenario.slice(0, 40) + '...'}
          </h2>
          <span style={{
            background: status === 'error' ? '#f55' : 'var(--bg-hover)',
            padding: '4px 10px', borderRadius: 4,
            fontSize: 11, color: status === 'error' ? '#fff' : 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {STATUS_RU[status] ?? status}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {project.mode} · {project.style}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {scenes.some(s => s.image_path) && !scenes.every(s => s.video_path) && (
            <ActionBtn onClick={() => genVideos.mutate()} loading={genVideos.isPending} label="Генерировать все видео" />
          )}
          {status === 'videos_ready' && (
            <ActionBtn onClick={() => render.mutate()} loading={render.isPending} label="Собрать видео" accent />
          )}
          {status === 'rendered' && project.final_video_path && (
            <a
              href={project.final_video_path}
              download
              style={{
                background: 'var(--accent)', color: 'var(--text-card)',
                border: '1.5px solid var(--text-card)',
                borderRadius: 'var(--radius-pill)', padding: '10px 24px',
                fontWeight: 800, fontSize: 14, textTransform: 'uppercase',
              }}
            >
              Экспорт видео
            </a>
          )}
          <button
            onClick={() => deleteMut.mutate()}
            style={{ color: '#f55', fontSize: 12, padding: '8px 12px' }}
          >
            Удалить
          </button>
        </div>
      </div>

      {/* Status banner for 'created' */}
      {status === 'created' && <StatusBanner text="ИИ разбивает сценарий на сцены..." />}

      {/* Canvas with cards */}
      {scenes.length > 0 && (
        <div style={{
          flex: 1, overflowX: 'auto', overflowY: 'hidden',
          display: 'flex', alignItems: 'center', padding: '40px 32px',
          backgroundImage: 'radial-gradient(#222 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', paddingRight: 100 }}>
            {scenes.map((scene, i) => (
              <div key={scene.id} style={{ display: 'flex', alignItems: 'center' }}>
                <FrameCard scene={scene} projectId={projectId} />
                {i < scenes.length - 1 && <TransitionNode />}
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  )
}


/* -- Frame Card ------------------------------------------------------------ */

function FrameCard({ scene, projectId }: { scene: Scene; projectId: string }) {
  const qc = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [imagePrompt, setImagePrompt]     = useState(scene.image_prompt ?? '')
  const [videoPrompt, setVideoPrompt]     = useState(scene.video_prompt ?? '')
  const [justAppeared, setJustAppeared]   = useState(false)
  const prevImagePath = useRef(scene.image_path)

  // Detect when image_path appears (was null, now has value) → trigger pop animation
  useEffect(() => {
    if (!prevImagePath.current && scene.image_path) {
      setJustAppeared(true)
      const t = setTimeout(() => setJustAppeared(false), 600)
      return () => clearTimeout(t)
    }
    prevImagePath.current = scene.image_path
  }, [scene.image_path])

  const genImage = useMutation({
    mutationFn: () => regenerateSceneImage(projectId, scene.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })
  const genVideo = useMutation({
    mutationFn: () => regenerateSceneVideo(projectId, scene.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })
  const saveMut = useMutation({
    mutationFn: () => updateScene(projectId, scene.id, {
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      setEditingPrompt(false)
    },
  })

  const hasVideo = !!scene.video_path
  const hasImage = !!scene.image_path
  const isGeneratingImage = scene.status === 'generating'
  const isGeneratingVideo = scene.video_status === 'generating' || scene.video_status === 'queued'

  function handleHover(enter: boolean) {
    if (!videoRef.current) return
    if (enter) videoRef.current.play().catch(() => {})
    else { videoRef.current.pause(); videoRef.current.currentTime = 0 }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4 }}
      onMouseEnter={() => handleHover(true)}
      onMouseLeave={() => handleHover(false)}
      style={{
        width: 320, flexShrink: 0,
        background: '#fff', borderRadius: 16, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 12,
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      }}
    >
      {/* Preview area */}
      <div style={{
        width: '100%', height: 180, borderRadius: 8, overflow: 'hidden',
        position: 'relative', background: '#f0f0f0',
        border: '1px solid #e5e5e5',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundImage: !hasImage && !hasVideo && !isGeneratingImage
          ? 'repeating-linear-gradient(45deg, #eee 0, #eee 10px, #f5f5f5 10px, #f5f5f5 20px)'
          : undefined,
      }}>
        {hasVideo ? (
          <video
            ref={videoRef}
            src={scene.video_path!}
            muted loop playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            poster={scene.image_path ?? undefined}
          />
        ) : hasImage ? (
          <motion.img
            src={scene.image_path!}
            alt={`Сцена ${scene.scene_number}`}
            initial={justAppeared ? { scale: 1.15 } : { scale: 1 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          !isGeneratingImage && (
            <span style={{ color: '#ccc', fontSize: 13, fontWeight: 500 }}>
              Нет кадра
            </span>
          )
        )}

        {/* Duration badge */}
        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          background: '#EA2B98', color: '#000',
          border: '1px solid #000', borderRadius: '50px',
          padding: '4px 12px', fontSize: 11, fontWeight: 800,
          boxShadow: '2px 2px 0px rgba(0,0,0,0.1)',
        }}>
          {scene.clip_duration}s
        </div>

        {/* Scene number */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700,
        }}>
          #{scene.scene_number}
        </div>

        {/* Image generating overlay */}
        {isGeneratingImage && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>
              Создаем кадр...
            </span>
          </div>
        )}

        {/* Video generating overlay */}
        {isGeneratingVideo && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>
              Создаем видео...
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '0 4px' }}>
        <AnimatePresence mode="wait">
          {editingPrompt ? (
            <motion.div
              key="edit"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <label style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>Image prompt</label>
              <textarea
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                rows={2}
                style={{
                  width: '100%', fontSize: 12, background: '#f8f8f8', color: '#000',
                  border: '1px solid #ddd', borderRadius: 6, padding: '6px 8px', resize: 'vertical',
                }}
              />
              <label style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>Video prompt</label>
              <textarea
                value={videoPrompt}
                onChange={(e) => setVideoPrompt(e.target.value)}
                rows={2}
                style={{
                  width: '100%', fontSize: 12, background: '#f8f8f8', color: '#000',
                  border: '1px solid #ddd', borderRadius: 6, padding: '6px 8px', resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => saveMut.mutate()}
                  style={{
                    flex: 1, background: '#D4FF45', color: '#000', border: '1.5px solid #000',
                    borderRadius: 999, padding: '6px', fontSize: 12, fontWeight: 700,
                  }}
                >
                  {saveMut.isPending ? '...' : 'Сохранить'}
                </button>
                <button
                  onClick={() => setEditingPrompt(false)}
                  style={{ color: '#999', fontSize: 12, padding: '6px 10px' }}
                >
                  Отмена
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.p
              key="desc"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{ color: '#000', fontSize: 13, lineHeight: 1.5, minHeight: 40 }}
            >
              {scene.description?.slice(0, 120) ?? scene.image_prompt?.slice(0, 120) ?? ''}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Actions */}
      {!editingPrompt && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center',
          borderTop: '1px solid #eee', padding: '10px 4px 0',
        }}>
          {/* Edit prompt */}
          <IconBtn title="Редактировать промпт" onClick={() => setEditingPrompt(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
          </IconBtn>

          {/* Settings */}
          <IconBtn title="Настройки кадра" onClick={() => {}}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </IconBtn>

          {/* Action buttons */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {!hasImage && !isGeneratingImage ? (
              /* CREATE button — prominent pink */
              <button
                onClick={() => genImage.mutate()}
                disabled={genImage.isPending}
                style={{
                  background: '#EA2B98', color: '#000',
                  border: '1px solid #000', borderRadius: 50,
                  padding: '6px 16px', fontSize: 12, fontWeight: 800,
                  cursor: 'pointer',
                  opacity: genImage.isPending ? 0.6 : 1,
                }}
              >
                {genImage.isPending ? '...' : 'Создать'}
              </button>
            ) : (
              <>
                {hasImage && (
                  <button
                    onClick={() => genImage.mutate()}
                    disabled={genImage.isPending || isGeneratingImage}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      color: '#666', fontSize: 11, fontWeight: 600,
                      padding: '4px 8px', borderRadius: 4,
                      opacity: (genImage.isPending || isGeneratingImage) ? 0.5 : 1,
                      cursor: 'pointer',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    {genImage.isPending ? '...' : 'Пересоздать картинку'}
                  </button>
                )}
                {hasVideo && (
                  <button
                    onClick={() => genVideo.mutate()}
                    disabled={genVideo.isPending || isGeneratingVideo}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      color: '#666', fontSize: 11, fontWeight: 600,
                      padding: '4px 8px', borderRadius: 4,
                      opacity: (genVideo.isPending || isGeneratingVideo) ? 0.5 : 1,
                      cursor: 'pointer',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    {genVideo.isPending ? '...' : 'Пересоздать видео'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}


/* -- Transition Node ------------------------------------------------------- */

function TransitionNode() {
  const [idx, setIdx] = useState(0)

  function cycle() {
    setIdx((i) => (i + 1) % TRANSITIONS.length)
  }

  const colors: Record<string, string> = {
    CUT:  '#45A055',
    FADE: '#EA2B98',
  }

  const t = TRANSITIONS[idx]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', width: 60, flexShrink: 0, position: 'relative',
    }}>
      <div style={{ width: 30, height: 2, background: '#333' }} />
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={cycle}
        style={{
          position: 'absolute',
          background: colors[t] ?? '#45A055',
          border: '1px solid #000',
          borderRadius: 12, padding: '4px 10px',
          fontSize: 10, fontWeight: 800, color: '#000',
          cursor: 'pointer',
          rotate: '-5deg',
        }}
      >
        {t}
      </motion.button>
    </div>
  )
}


/* -- Small components ------------------------------------------------------ */

function IconBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: 4, borderRadius: 4, color: '#999',
        display: 'flex', alignItems: 'center',
      }}
    >
      <span style={{ width: 16, height: 16, display: 'flex' }}>{children}</span>
    </button>
  )
}

function ActionBtn({ onClick, loading, label, accent }: {
  onClick: () => void; loading: boolean; label: string; accent?: boolean
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      disabled={loading}
      style={{
        background:   accent ? 'var(--accent)' : 'var(--bg-card)',
        color:        accent ? 'var(--text-card)' : 'var(--text)',
        border:       accent ? '1.5px solid var(--text-card)' : '1px solid var(--border)',
        borderRadius: 'var(--radius-pill)',
        padding:      '8px 18px',
        fontWeight:   700,
        fontSize:     13,
        opacity:      loading ? 0.6 : 1,
      }}
    >
      {loading ? '...' : label}
    </motion.button>
  )
}

function StatusBanner({ text }: { text: string }) {
  return (
    <motion.div
      animate={{ opacity: [0.6, 1, 0.6] }}
      transition={{ duration: 1.8, repeat: Infinity }}
      style={{ color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' }}
    >
      {text}
    </motion.div>
  )
}
