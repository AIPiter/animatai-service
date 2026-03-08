import { motion } from 'framer-motion'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getProject, generateImages, startVideoGeneration, renderProject, deleteProject } from '../api/projects'
import { useProjectEvents } from '../hooks/useProjectEvents'
import type { Scene } from '../types'

interface Props {
  projectId: string
  onDelete:  () => void
}

export default function ProjectView({ projectId, onDelete }: Props) {
  const qc = useQueryClient()
  useProjectEvents(projectId)

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn:  () => getProject(projectId),
    refetchInterval: 8000,
  })

  const genImages  = useMutation({ mutationFn: () => generateImages(projectId),     onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }) })
  const genVideos  = useMutation({ mutationFn: () => startVideoGeneration(projectId), onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }) })
  const render     = useMutation({ mutationFn: () => renderProject(projectId),       onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }) })
  const deleteMut  = useMutation({ mutationFn: () => deleteProject(projectId),       onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }); onDelete() } })

  if (isLoading) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Загрузка…</div>
  if (!project)  return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Проект не найден</div>

  const scenes = project.scenes ?? []
  const status = project.status

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{
        height:    '100%',
        overflowY: 'auto',
        background: `radial-gradient(#222 1px, transparent 1px)`,
        backgroundSize: '20px 20px',
        padding:   '24px 32px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800 }}>
            {project.name ?? project.scenario.slice(0, 40) + '…'}
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
            Режим: <b style={{ color: 'var(--accent)' }}>{project.mode}</b> · Стиль: {project.style} · Статус: {status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {status === 'scenes_ready' && (
            <ActionBtn onClick={() => genImages.mutate()} loading={genImages.isPending} label="Генерировать изображения" />
          )}
          {status === 'scenes_ready' && (
            <ActionBtn onClick={() => genVideos.mutate()} loading={genVideos.isPending} label="Генерировать видео" />
          )}
          {status === 'videos_ready' && (
            <ActionBtn onClick={() => render.mutate()} loading={render.isPending} label="Собрать финальное видео" accent />
          )}
          {status === 'rendered' && project.final_video_path && (
            <a
              href={project.final_video_path}
              download
              style={{ background: 'var(--accent)', color: 'var(--text-card)', borderRadius: 'var(--radius-pill)', padding: '8px 20px', fontWeight: 700, fontSize: 13 }}
            >
              Скачать
            </a>
          )}
          <button
            onClick={() => deleteMut.mutate()}
            style={{ color: '#f55', fontSize: 13, padding: '8px 12px' }}
          >
            Удалить
          </button>
        </div>
      </div>

      {/* Scene timeline */}
      {status === 'created' && (
        <StatusBanner text="ИИ разбивает сценарий на сцены…" />
      )}

      {scenes.length > 0 && (
        <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 16 }}>
          {scenes.map((scene) => (
            <SceneCard key={scene.id} scene={scene} />
          ))}
        </div>
      )}
    </motion.div>
  )
}

function SceneCard({ scene }: { scene: Scene }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        minWidth:     200,
        maxWidth:     220,
        background:   'var(--bg-card)',
        border:       '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow:     'hidden',
        flexShrink:   0,
      }}
    >
      {/* Image */}
      <div style={{ width: '100%', paddingTop: '56.25%', position: 'relative', background: 'var(--bg-hover)' }}>
        {scene.image_path ? (
          <img
            src={scene.image_path}
            alt={`Scene ${scene.scene_number}`}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {scene.status === 'pending' ? '…' : scene.status === 'error' ? '✕' : '?'}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
          Сцена {scene.scene_number}
          {scene.video_status === 'done' && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>● видео</span>}
          {scene.video_status === 'generating' && <span style={{ color: '#fa0', marginLeft: 6 }}>● генерирую…</span>}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, margin: 0 }}>
          {scene.description?.slice(0, 80) ?? ''}
        </p>
      </div>
    </motion.div>
  )
}

function ActionBtn({ onClick, loading, label, accent }: { onClick: () => void; loading: boolean; label: string; accent?: boolean }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      disabled={loading}
      style={{
        background:   accent ? 'var(--accent)' : 'var(--bg-card)',
        color:        accent ? 'var(--text-card)' : 'var(--text)',
        border:       accent ? 'none' : '1px solid var(--border)',
        borderRadius: 'var(--radius-pill)',
        padding:      '8px 18px',
        fontWeight:   700,
        fontSize:     13,
        opacity:      loading ? 0.6 : 1,
      }}
    >
      {loading ? '…' : label}
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
