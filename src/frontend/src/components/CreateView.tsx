import { useState } from 'react'
import { motion } from 'framer-motion'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createProject } from '../api/projects'

interface Props {
  onCancel:  () => void
  onCreated: (id: string) => void
}

const MODES   = [
  { value: 'standard', label: 'Стандарт', desc: 'Автоматическая генерация с постоянством стиля' },
  { value: 'lite',     label: 'Lite',     desc: 'Быстрая генерация без привязки стиля' },
  { value: 'deluxe',   label: 'Deluxe',   desc: 'Цепочка кадров с аудио и высоким качеством' },
]
const STYLES  = [{ value: 'anime', label: 'Аниме' }, { value: 'cartoon', label: 'Мультфильм' }, { value: 'pixar', label: 'Pixar 3D' }]
const DURATIONS = [{ value: 30, label: '30 сек' }, { value: 60, label: '1 мин' }, { value: 120, label: '2 мин' }]

export default function CreateView({ onCancel, onCreated }: Props) {
  const qc = useQueryClient()
  const [scenario, setScenario] = useState('')
  const [mode, setMode]         = useState('standard')
  const [style, setStyle]       = useState('anime')
  const [duration, setDuration] = useState(30)

  const { mutate, isPending, error } = useMutation({
    mutationFn: () => createProject({ scenario, mode, style, duration }),
    onSuccess:  ({ id }) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      onCreated(id)
    },
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      style={{ height: '100%', overflowY: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 24px' }}
    >
      <div style={{ width: '100%', maxWidth: 560 }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 8 }}>Новый мультфильм</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 32, fontSize: 14 }}>
          Опиши сценарий — ИИ разобьёт его на сцены
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>СЦЕНАРИЙ</label>
            <textarea
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              placeholder="Например: Маленькая лиса находит волшебный фонарь в лесу и открывает секрет своей семьи…"
              rows={5}
              style={{ width: '100%', resize: 'vertical', fontSize: 14, lineHeight: 1.6 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <SegmentedControl label="РЕЖИМ"      options={MODES}      value={mode}     onChange={setMode} />
            <SegmentedControl label="СТИЛЬ"      options={STYLES}     value={style}    onChange={setStyle} />
            <SegmentedControl label="ДЛИНА"      options={DURATIONS}  value={duration} onChange={(v) => setDuration(Number(v))} />
          </div>

          {error && (
            <p style={{ color: '#f55', fontSize: 13 }}>
              {(error as any).message ?? 'Ошибка создания'}
            </p>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <motion.button
              whileTap={{ scale: 0.97 }}
              disabled={!scenario.trim() || isPending}
              onClick={() => mutate()}
              style={{
                flex: 1, background: 'var(--accent)', color: 'var(--text-card)',
                borderRadius: 'var(--radius-pill)', padding: '13px',
                fontWeight: 800, fontSize: 15, opacity: isPending || !scenario.trim() ? 0.6 : 1,
              }}
            >
              {isPending ? 'Создаём…' : 'Создать'}
            </motion.button>
            <button
              onClick={onCancel}
              style={{ color: 'var(--text-muted)', fontSize: 14, padding: '0 16px' }}
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function SegmentedControl({ label, options, value, onChange }: {
  label:    string
  options:  { value: string | number; label: string; desc?: string }[]
  value:    string | number
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>{label}</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {options.map((o) => {
          const selected = String(o.value) === String(value)
          return (
            <button
              key={String(o.value)}
              onClick={() => onChange(String(o.value))}
              style={{
                padding:      '7px 10px',
                borderRadius: 'var(--radius)',
                fontSize:     13,
                textAlign:    'left',
                background:   selected ? 'var(--bg-hover)' : 'transparent',
                color:        selected ? 'var(--accent)' : 'var(--text-muted)',
                border:       `1px solid ${selected ? 'var(--border)' : 'transparent'}`,
                fontWeight:   selected ? 600 : 400,
              }}
            >
              {o.label}
              {o.desc && selected && (
                <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginTop: 2 }}>
                  {o.desc}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
