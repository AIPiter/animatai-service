import { useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../store/useStore'

interface Props { onClose: () => void }

export default function ApiKeysModal({ onClose }: Props) {
  const { falKey, openrouterKey, setFalKey, setOpenrouterKey } = useStore()
  const [fal, setFal]             = useState(falKey)
  const [openrouter, setOpenrouter] = useState(openrouterKey)

  function save() {
    setFalKey(fal.trim())
    setOpenrouterKey(openrouter.trim())
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 28,
          width: '100%',
          maxWidth: 440,
        }}
      >
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>API ключи</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
          Ключи хранятся локально в браузере и передаются только при генерации.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              OPENROUTER API KEY
            </label>
            <input
              type="password"
              value={openrouter}
              onChange={(e) => setOpenrouter(e.target.value)}
              placeholder="sk-or-..."
              style={{ width: '100%', fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              FAL.AI API KEY
            </label>
            <input
              type="password"
              value={fal}
              onChange={(e) => setFal(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:..."
              style={{ width: '100%', fontSize: 13 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={save}
              style={{
                flex: 1, background: 'var(--accent)', color: 'var(--text-card)',
                borderRadius: 'var(--radius-pill)', padding: '11px',
                fontWeight: 700, fontSize: 14,
              }}
            >
              Сохранить
            </motion.button>
            <button
              onClick={onClose}
              style={{ color: 'var(--text-muted)', fontSize: 13, padding: '0 16px' }}
            >
              Отмена
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
