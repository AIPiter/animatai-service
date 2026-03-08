import { useState } from 'react'
import { motion } from 'framer-motion'
import { register } from '../api/auth'
import { useStore } from '../store/useStore'

interface Props {
  onSuccess: () => void
  onBack:    () => void
}

export default function RegisterView({ onSuccess, onBack }: Props) {
  const setAuth = useStore((s) => s.setAuth)
  const [email, setEmail]       = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await register(email, username, password)
      setAuth(true, username)
      onSuccess()
    } catch (err: any) {
      setError(err.message ?? 'Ошибка регистрации')
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
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 32 }}>Регистрация</h1>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input type="email" placeholder="Email" value={email} required onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', fontSize: 15 }} />
          <input type="text" placeholder="Имя пользователя" value={username} required minLength={3} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%', fontSize: 15 }} />
          <input type="password" placeholder="Пароль (мин. 6 символов)" value={password} required minLength={6} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', fontSize: 15 }} />
          {error && <p style={{ color: '#f55', fontSize: 13 }}>{error}</p>}
          <motion.button type="submit" disabled={loading} whileTap={{ scale: 0.97 }}
            style={{ background: 'var(--accent)', color: 'var(--text-card)', borderRadius: 'var(--radius-pill)', padding: '13px', fontSize: 15, fontWeight: 800, opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
          </motion.button>
        </form>
        <button onClick={onBack} style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 24 }}>← Назад</button>
      </div>
    </motion.div>
  )
}
