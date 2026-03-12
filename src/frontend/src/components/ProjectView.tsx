import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProject, renderProject,
  updateScene, regenerateSceneImage, regenerateSceneVideo,
  resumePipeline,
} from '../api/projects'
import { useProjectEvents } from '../hooks/useProjectEvents'
import type { Scene, ProjectStatus, PipelineStage } from '../types'

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

export default function ProjectView({ projectId, onDelete: _onDelete }: Props) {
  useProjectEvents(projectId)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn:  () => getProject(projectId),
    refetchInterval: 8000,
  })

  if (isLoading) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Загрузка...</div>
  if (!project)  return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Проект не найден</div>

  // Route standard mode to its dedicated pipeline UI
  if (project.mode === 'standard') {
    return <StandardPipelineView project={project} projectId={projectId} />
  }

  return <ClassicProjectView project={project} projectId={projectId} />
}


/* ═══════════════════════════════════════════════════════════════════════════
   Classic Project View (lite / deluxe)
   ═══════════════════════════════════════════════════════════════════════════ */

function ClassicProjectView({ project, projectId }: { project: any; projectId: string }) {
  const qc = useQueryClient()

  const renderMut = useMutation({
    mutationFn: () => renderProject(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const scenes = project.scenes ?? []
  const status = project.status
  const allVideosReady = scenes.length > 0 && scenes.every((s: Scene) => s.video_path)
  const isRendered = status === 'rendered' && project.final_video_path

  function handleExport() {
    if (isRendered && project?.final_video_path) {
      window.open(project.final_video_path, '_blank')
    } else if (allVideosReady) {
      renderMut.mutate()
    }
  }

  const exportEnabled = allVideosReady || isRendered
  const exportLabel = renderMut.isPending || status === 'rendering'
    ? 'Сборка...'
    : isRendered
      ? 'Скачать видео'
      : 'Экспортировать'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <TopBar project={project} status={status}>
        <motion.button
          whileHover={exportEnabled ? { scale: 1.03 } : {}}
          whileTap={exportEnabled ? { scale: 0.97 } : {}}
          onClick={handleExport}
          disabled={!exportEnabled || renderMut.isPending}
          style={{
            background: exportEnabled ? 'var(--accent)' : 'var(--bg-hover)',
            color: exportEnabled ? 'var(--text-card)' : 'var(--text-muted)',
            border: exportEnabled ? '1.5px solid var(--text-card)' : '1px solid var(--border)',
            borderRadius: 'var(--radius-pill)',
            padding: '10px 28px',
            fontWeight: 800, fontSize: 13,
            boxShadow: exportEnabled ? '0 4px 0 #7a9a00' : 'none',
            opacity: renderMut.isPending ? 0.6 : 1,
            cursor: exportEnabled ? 'pointer' : 'not-allowed',
          }}
        >
          {exportLabel}
        </motion.button>
      </TopBar>

      {status === 'created' && <StatusBanner text="ИИ разбивает сценарий на сцены..." />}

      {scenes.length > 0 && (
        <div style={{
          flex: 1, overflowX: 'auto', overflowY: 'hidden',
          display: 'flex', alignItems: 'center', padding: '40px 32px',
          backgroundImage: 'radial-gradient(#222 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', paddingRight: 100 }}>
            {scenes.map((scene: Scene, i: number) => (
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


/* ═══════════════════════════════════════════════════════════════════════════
   Standard Pipeline View
   ═══════════════════════════════════════════════════════════════════════════ */

const PIPELINE_STAGES: { key: PipelineStage; label: string }[] = [
  { key: 'parsing',        label: 'Анализ сценария' },
  { key: 'master_image',   label: 'Создание эталонного изображения' },
  { key: 'visual_anchor',  label: 'Извлечение визуального якоря' },
  { key: 'frames',         label: 'Генерация ключевых кадров' },
  { key: 'clips',          label: 'Генерация видеоклипов' },
  { key: 'concat',         label: 'Сборка финального видео' },
]

function inferPipelineStage(project: any): PipelineStage {
  const status = project.status as ProjectStatus
  const scenes = (project.scenes ?? []) as Scene[]

  if (status === 'rendered' && project.final_video_path) return 'complete'
  if (status === 'rendering') return 'concat'
  if (status === 'generating_videos') return 'clips'
  if (status === 'error') return 'failed'

  // Check if all scenes have videos
  if (scenes.length > 0 && scenes.every(s => s.video_path)) return 'complete'

  // Check if scenes have images → frames_ready (PAUSE point)
  const withImages = scenes.filter(s => s.image_path)
  if (scenes.length > 0 && withImages.length === scenes.length) return 'frames_ready'

  // Pipeline in progress — infer from scene states
  if (scenes.length > 0 && withImages.length > 0) return 'frames'
  if (status === 'scenes_ready') return 'frames_ready'
  if (status === 'created') return 'parsing'

  return 'parsing'
}

function stageOrder(stage: PipelineStage): number {
  const order: Record<string, number> = {
    parsing: 0, master_image: 1, visual_anchor: 2, frames: 3,
    frames_ready: 3.5, video_prompts: 4, clips: 4, concat: 5, complete: 6, failed: -1,
  }
  return order[stage] ?? 0
}

function StandardPipelineView({ project, projectId }: { project: any; projectId: string }) {
  const qc = useQueryClient()
  const currentStage = inferPipelineStage(project)
  const scenes = (project.scenes ?? []) as Scene[]
  const isComplete = currentStage === 'complete'
  const isFailed = currentStage === 'failed'
  const isFramesReady = currentStage === 'frames_ready'

  const resumeMut = useMutation({
    mutationFn: () => resumePipeline(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <TopBar project={project} status={project.status}>
        {isComplete && project.final_video_path && (
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => window.open(project.final_video_path, '_blank')}
            style={{
              background: 'var(--accent)', color: 'var(--text-card)',
              border: '1.5px solid var(--text-card)',
              borderRadius: 'var(--radius-pill)',
              padding: '10px 28px', fontWeight: 800, fontSize: 13,
              boxShadow: '0 4px 0 #7a9a00',
            }}
          >
            Скачать видео
          </motion.button>
        )}
      </TopBar>

      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>

          {/* Pipeline progress tracker */}
          {!isComplete && !isFramesReady && (
            <PipelineProgress currentStage={currentStage} scenes={scenes} />
          )}

          {/* Error state */}
          {isFailed && (
            <div style={{
              background: 'rgba(255,85,85,0.1)', border: '1px solid #f55',
              borderRadius: 12, padding: '20px 24px', marginBottom: 24,
            }}>
              <p style={{ color: '#f55', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                Произошла ошибка
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Попробуйте создать проект заново.
              </p>
            </div>
          )}

          {/* Master image preview (show as soon as scene 1 has an image) */}
          {!isFramesReady && !isComplete && scenes.length > 0 && scenes[0]?.image_path && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8, textTransform: 'uppercase' }}>
                Эталонное изображение
              </p>
              <img
                src={scenes[0].image_path}
                alt="Master"
                style={{ width: 200, height: 200, borderRadius: 12, objectFit: 'cover', border: '1px solid var(--border)' }}
              />
            </div>
          )}

          {/* Frame Approval Screen (PAUSE point) */}
          {isFramesReady && (
            <FrameApprovalScreen
              scenes={scenes}
              projectId={projectId}
              onApprove={() => resumeMut.mutate()}
              isResuming={resumeMut.isPending}
            />
          )}

          {/* Clip generation progress */}
          {(currentStage === 'clips' || currentStage === 'concat') && (
            <ClipProgressView scenes={scenes} currentStage={currentStage} />
          )}

          {/* Final result */}
          {isComplete && (
            <FinalResultView project={project} scenes={scenes} />
          )}
        </div>
      </div>
    </motion.div>
  )
}


/* -- Pipeline Progress ---------------------------------------------------- */

function PipelineProgress({ currentStage, scenes }: { currentStage: PipelineStage; scenes: Scene[] }) {
  const current = stageOrder(currentStage)

  // Count frames with images for progress text
  const framesWithImages = scenes.filter(s => s.image_path).length
  const totalScenes = scenes.length

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PIPELINE_STAGES.map(({ key, label }) => {
          const order = stageOrder(key)
          const isDone = current > order
          const isActive = Math.floor(current) === Math.floor(order) && !isDone
          const isPending = current < order

          let icon = '○'
          let color = 'var(--text-muted)'
          if (isDone) { icon = '✓'; color = 'var(--accent)' }
          else if (isActive) { icon = '◉'; color = 'var(--text)' }

          let extra = ''
          if (key === 'frames' && isActive && totalScenes > 0) {
            extra = ` (${framesWithImages}/${totalScenes})`
          }

          return (
            <motion.div
              key={key}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                opacity: isPending ? 0.4 : 1,
              }}
            >
              <span style={{ fontSize: 16, color, width: 20, textAlign: 'center', fontWeight: 700 }}>
                {icon}
              </span>
              <span style={{ fontSize: 14, color, fontWeight: isActive ? 600 : 400 }}>
                {label}{extra}
              </span>
              {isActive && (
                <motion.span
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                  style={{ fontSize: 12, color: 'var(--text-muted)' }}
                >
                  ...
                </motion.span>
              )}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}


/* -- Frame Approval Screen ------------------------------------------------ */

function FrameApprovalScreen({
  scenes, projectId, onApprove, isResuming,
}: {
  scenes: Scene[]; projectId: string; onApprove: () => void; isResuming: boolean
}) {
  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>
        Проверьте ключевые кадры
      </h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Убедитесь, что стиль и объект выглядят правильно
      </p>

      {/* Frame grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 16, marginBottom: 32,
      }}>
        {scenes.map((scene) => (
          <ApprovalFrameCard
            key={scene.id}
            scene={scene}
            projectId={projectId}
          />
        ))}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={onApprove}
          disabled={isResuming}
          style={{
            background: 'var(--accent)', color: 'var(--text-card)',
            border: '1.5px solid var(--text-card)',
            borderRadius: 'var(--radius-pill)',
            padding: '13px 32px', fontWeight: 800, fontSize: 14,
            boxShadow: '0 4px 0 #7a9a00',
            opacity: isResuming ? 0.6 : 1,
            cursor: isResuming ? 'wait' : 'pointer',
          }}
        >
          {isResuming ? 'Запускаем...' : 'Всё хорошо — создать видео'}
        </motion.button>
      </div>
    </div>
  )
}


function ApprovalFrameCard({ scene, projectId }: { scene: Scene; projectId: string }) {
  const qc = useQueryClient()
  const regenMut = useMutation({
    mutationFn: () => regenerateSceneImage(projectId, scene.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const isRegenerating = regenMut.isPending || scene.status === 'generating'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'var(--bg-card)', borderRadius: 12,
        border: '1px solid var(--border)', overflow: 'hidden',
      }}
    >
      {/* Image preview */}
      <div style={{
        width: '100%', aspectRatio: '16/9', position: 'relative',
        background: '#1a1a1a',
      }}>
        {scene.image_path ? (
          <img
            src={scene.image_path}
            alt={`Кадр ${scene.scene_number}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Нет кадра</span>
          </div>
        )}

        {isRegenerating && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>Пересоздаём...</span>
          </div>
        )}

        {/* Frame index */}
        <div style={{
          position: 'absolute', top: 6, left: 6,
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700,
        }}>
          #{scene.scene_number}
        </div>
      </div>

      {/* Info + regen button */}
      <div style={{ padding: '10px 12px' }}>
        <p style={{ color: 'var(--text)', fontSize: 12, lineHeight: 1.4, marginBottom: 8, minHeight: 34 }}>
          {scene.description?.slice(0, 80) ?? ''}
        </p>
        <button
          onClick={() => regenMut.mutate()}
          disabled={isRegenerating}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            color: 'var(--text-muted)', fontSize: 11, fontWeight: 500,
            padding: '4px 0', cursor: isRegenerating ? 'wait' : 'pointer',
            opacity: isRegenerating ? 0.5 : 1,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Перегенерировать
        </button>
      </div>
    </motion.div>
  )
}


/* -- Clip Progress -------------------------------------------------------- */

function ClipProgressView({ scenes, currentStage }: { scenes: Scene[]; currentStage: PipelineStage }) {
  const doneClips = scenes.filter(s => s.video_path).length
  const total = scenes.length

  return (
    <div>
      <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        Генерация видеоклипов
      </h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
        {currentStage === 'concat'
          ? 'Собираем финальное видео...'
          : `Клипы: ${doneClips}/${total} готово`
        }
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 16,
      }}>
        {scenes.map((scene) => (
          <div
            key={scene.id}
            style={{
              background: 'var(--bg-card)', borderRadius: 12,
              border: '1px solid var(--border)', overflow: 'hidden',
            }}
          >
            <div style={{ width: '100%', aspectRatio: '16/9', background: '#111', position: 'relative' }}>
              {scene.video_path ? (
                <video
                  src={scene.video_path}
                  autoPlay muted loop playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : scene.image_path ? (
                <>
                  <img
                    src={scene.image_path}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.4 }}
                  />
                  <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <motion.span
                      animate={{ opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                      style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}
                    >
                      Создаём клип...
                    </motion.span>
                  </div>
                </>
              ) : null}

              <div style={{
                position: 'absolute', top: 6, left: 6,
                background: scene.video_path ? 'var(--accent)' : 'rgba(0,0,0,0.7)',
                color: scene.video_path ? '#000' : '#fff',
                borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700,
              }}>
                {scene.video_path ? '✓' : '...'} #{scene.scene_number}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


/* -- Final Result --------------------------------------------------------- */

function FinalResultView({ project, scenes }: { project: any; scenes: Scene[] }) {
  const allVideosReady = scenes.length > 0 && scenes.every(s => s.video_path)

  return (
    <div>
      {project.final_video_path ? (
        <>
          <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 16 }}>
            Видео готово
          </h3>
          <div style={{
            borderRadius: 16, overflow: 'hidden',
            border: '1px solid var(--border)', marginBottom: 24,
          }}>
            <video
              src={project.final_video_path}
              controls autoPlay muted
              style={{ width: '100%', maxHeight: 480, background: '#000' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <motion.a
              href={project.final_video_path}
              download
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              style={{
                background: 'var(--accent)', color: 'var(--text-card)',
                border: '1.5px solid var(--text-card)',
                borderRadius: 'var(--radius-pill)',
                padding: '13px 32px', fontWeight: 800, fontSize: 14,
                boxShadow: '0 4px 0 #7a9a00',
                textDecoration: 'none', display: 'inline-block',
              }}
            >
              Скачать видео
            </motion.a>
          </div>
        </>
      ) : allVideosReady ? (
        <>
          <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Все клипы готовы
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
            Клипы сгенерированы. Используйте экспорт для сборки финального видео.
          </p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 12,
          }}>
            {scenes.map((s) => s.video_path && (
              <div key={s.id} style={{
                borderRadius: 12, overflow: 'hidden',
                border: '1px solid var(--border)',
              }}>
                <video
                  src={s.video_path}
                  controls muted playsInline
                  style={{ width: '100%', background: '#000' }}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}


/* ═══════════════════════════════════════════════════════════════════════════
   Shared / Classic components
   ═══════════════════════════════════════════════════════════════════════════ */

function TopBar({ project, status, children }: {
  project: any; status: ProjectStatus; children?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 32px', height: 64, borderBottom: '1px solid var(--border)', flexShrink: 0,
    }}>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', textAlign: 'center' }}>
          {project.name ?? project.scenario.slice(0, 40) + '...'}
        </h2>
        <span style={{
          background: status === 'error' ? '#f55' : 'var(--bg-hover)',
          padding: '2px 10px', borderRadius: 4,
          fontSize: 10, color: status === 'error' ? '#fff' : 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {STATUS_RU[status] ?? status}
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
        {children}
      </div>
    </div>
  )
}


/* -- Frame Card (lite/deluxe) --------------------------------------------- */

function FrameCard({ scene, projectId }: { scene: Scene; projectId: string }) {
  const qc = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [imagePrompt, setImagePrompt]     = useState(scene.image_prompt ?? '')
  const [videoPrompt, setVideoPrompt]     = useState(scene.video_prompt ?? '')
  const [justAppeared, setJustAppeared]   = useState(false)
  const prevImagePath = useRef(scene.image_path)

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

  const downloadPath = hasVideo ? scene.video_path : hasImage ? scene.image_path : null

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
          <video ref={videoRef} src={scene.video_path!} muted loop playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            poster={scene.image_path ?? undefined} />
        ) : hasImage ? (
          <motion.img src={scene.image_path!} alt={`Сцена ${scene.scene_number}`}
            initial={justAppeared ? { scale: 1.15 } : { scale: 1 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          !isGeneratingImage && <span style={{ color: '#ccc', fontSize: 13, fontWeight: 500 }}>Нет кадра</span>
        )}

        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          background: '#EA2B98', color: '#000', border: '1px solid #000',
          borderRadius: 50, padding: '4px 12px', fontSize: 11, fontWeight: 800,
          boxShadow: '2px 2px 0px rgba(0,0,0,0.1)',
        }}>
          {scene.clip_duration}s
        </div>

        <div style={{
          position: 'absolute', top: 8, left: 8,
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700,
        }}>
          #{scene.scene_number}
        </div>

        {isGeneratingImage && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>Создаем кадр...</span>
          </div>
        )}
        {isGeneratingVideo && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>Создаем видео...</span>
          </div>
        )}
      </div>

      <div style={{ padding: '0 4px' }}>
        <AnimatePresence mode="wait">
          {editingPrompt ? (
            <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>Image prompt</label>
              <textarea value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} rows={2}
                style={{ width: '100%', fontSize: 12, background: '#f8f8f8', color: '#000',
                  border: '1px solid #ddd', borderRadius: 6, padding: '6px 8px', resize: 'vertical' }} />
              <label style={{ fontSize: 10, color: '#999', textTransform: 'uppercase' }}>Video prompt</label>
              <textarea value={videoPrompt} onChange={(e) => setVideoPrompt(e.target.value)} rows={2}
                style={{ width: '100%', fontSize: 12, background: '#f8f8f8', color: '#000',
                  border: '1px solid #ddd', borderRadius: 6, padding: '6px 8px', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => saveMut.mutate()} style={{ flex: 1, background: '#D4FF45', color: '#000',
                  border: '1.5px solid #000', borderRadius: 999, padding: '6px', fontSize: 12, fontWeight: 700 }}>
                  {saveMut.isPending ? '...' : 'Сохранить'}
                </button>
                <button onClick={() => setEditingPrompt(false)} style={{ color: '#999', fontSize: 12, padding: '6px 10px' }}>
                  Отмена
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.p key="desc" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ color: '#000', fontSize: 13, lineHeight: 1.5, minHeight: 40 }}>
              {scene.description?.slice(0, 120) ?? scene.image_prompt?.slice(0, 120) ?? ''}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {!editingPrompt && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center',
          borderTop: '1px solid #eee', padding: '10px 4px 0' }}>
          <IconBtn title="Настройки" onClick={() => setEditingPrompt(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </IconBtn>
          {hasImage && (
            <IconBtn title="Пересоздать картинку" onClick={() => genImage.mutate()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ opacity: (genImage.isPending || isGeneratingImage) ? 0.4 : 1 }}>
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </IconBtn>
          )}
          {downloadPath && (
            <a href={downloadPath} download title={hasVideo ? 'Скачать видео' : 'Скачать картинку'}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 4, borderRadius: 4, color: '#999', display: 'flex', alignItems: 'center' }}>
              <span style={{ width: 16, height: 16, display: 'flex' }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </span>
            </a>
          )}
          <div style={{ marginLeft: 'auto' }}>
            {!hasImage && !isGeneratingImage ? (
              <button onClick={() => genImage.mutate()} disabled={genImage.isPending}
                style={{ background: '#EA2B98', color: '#000', border: '1px solid #000', borderRadius: 50,
                  padding: '6px 16px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
                  opacity: genImage.isPending ? 0.6 : 1 }}>
                {genImage.isPending ? '...' : 'Создать'}
              </button>
            ) : hasImage && !hasVideo ? (
              <button onClick={() => genVideo.mutate()} disabled={genVideo.isPending || isGeneratingVideo}
                style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#EA2B98', color: '#000',
                  border: '1px solid #000', borderRadius: 50, padding: '6px 16px', fontSize: 12, fontWeight: 800,
                  cursor: 'pointer', opacity: (genVideo.isPending || isGeneratingVideo) ? 0.6 : 1 }}>
                {(genVideo.isPending || isGeneratingVideo) ? '...' : 'Создать клип'}
              </button>
            ) : hasVideo ? (
              <button onClick={() => genVideo.mutate()} disabled={genVideo.isPending || isGeneratingVideo}
                style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#666', fontSize: 11, fontWeight: 600,
                  padding: '4px 8px', borderRadius: 4, opacity: (genVideo.isPending || isGeneratingVideo) ? 0.5 : 1,
                  cursor: 'pointer' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {(genVideo.isPending || isGeneratingVideo) ? '...' : 'Пересоздать клип'}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </motion.div>
  )
}


function TransitionNode() {
  const [idx, setIdx] = useState(0)
  const t = TRANSITIONS[idx]
  const colors: Record<string, string> = { CUT: '#45A055', FADE: '#EA2B98' }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', width: 60, flexShrink: 0, position: 'relative',
    }}>
      <div style={{ width: 30, height: 2, background: '#333' }} />
      <motion.button
        whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}
        onClick={() => setIdx((i) => (i + 1) % TRANSITIONS.length)}
        style={{
          position: 'absolute', background: colors[t] ?? '#45A055',
          border: '1px solid #000', borderRadius: 12, padding: '4px 10px',
          fontSize: 10, fontWeight: 800, color: '#000', cursor: 'pointer', rotate: '-5deg',
        }}
      >
        {t}
      </motion.button>
    </div>
  )
}


function IconBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title}
      style={{ background: 'transparent', border: 'none', cursor: 'pointer',
        padding: 4, borderRadius: 4, color: '#999', display: 'flex', alignItems: 'center' }}>
      <span style={{ width: 16, height: 16, display: 'flex' }}>{children}</span>
    </button>
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
