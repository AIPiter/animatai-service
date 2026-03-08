import { useState } from 'react'
import { motion } from 'framer-motion'
import { login } from '../api/auth'
import { useStore } from '../store/useStore'

interface Props {
  onSuccess:  () => void
  onBack:     () => void
  onRegister: () => void
}

export default function LoginView({ onSuccess, onBack, onRegister }: Props) {
  const setAuth = useStore((s) => s.setAuth)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      setAuth(true, email.split('@')[0])
      onSuccess()
    } catch (err: any) {
      setError(err.message ?? 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Вход</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>
          Нет аккаунта?{' '}
          <button onClick={onRegister} style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Зарегистрироваться
          </button>
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input
            type="email" placeholder="Email" value={email} required
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', fontSize: 15 }}
          />
          <input
            type="password" placeholder="Пароль" value={password} required
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', fontSize: 15 }}
          />
          {error && <p style={{ color: '#f55', fontSize: 13 }}>{error}</p>}
          <motion.button
            type="submit"
            disabled={loading}
            whileTap={{ scale: 0.97 }}
            style={{
              background: 'var(--accent)', color: 'var(--text-card)',
              borderRadius: 'var(--radius-pill)', padding: '13px',
              fontSize: 15, fontWeight: 800, opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Входим…' : 'Войти'}
          </motion.button>
        </form>

        <button onClick={onBack} style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 24 }}>
          ← Назад
        </button>
      </div>
    </motion.div>
  )
}
