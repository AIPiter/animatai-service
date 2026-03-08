import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'

const FONT_VARIANTS = [
  { fontFamily: "'Inter', sans-serif",        fontWeight: '800', fontStyle: 'normal',  letterSpacing: '-.04em', textTransform: '' },
  { fontFamily: "'Playfair Display', serif",  fontWeight: '700', fontStyle: 'italic',  letterSpacing: '-.01em', textTransform: '' },
  { fontFamily: "'Oswald', sans-serif",       fontWeight: '700', fontStyle: 'normal',  letterSpacing: '.08em',  textTransform: 'uppercase' },
  { fontFamily: "'Unbounded', sans-serif",    fontWeight: '900', fontStyle: 'normal',  letterSpacing: '-.02em', textTransform: '' },
  { fontFamily: "'Russo One', sans-serif",    fontWeight: '400', fontStyle: 'normal',  letterSpacing: '.02em',  textTransform: '' },
  { fontFamily: "'Marck Script', cursive",    fontWeight: '400', fontStyle: 'normal',  letterSpacing: '-.01em', textTransform: '' },
  { fontFamily: "'Comfortaa', cursive",       fontWeight: '700', fontStyle: 'normal',  letterSpacing: '.01em',  textTransform: '' },
]

interface Props {
  onLogin:    () => void
  onRegister: () => void
}

export default function LandingView({ onLogin, onRegister }: Props) {
  const wordRef   = useRef<HTMLSpanElement>(null)
  const slotRef   = useRef<HTMLSpanElement>(null)
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const [fontIdx, setFontIdx] = useState(0)
  const [slotW, setSlotW]     = useState<number | undefined>(undefined)

  // Measure max width after fonts load
  useEffect(() => {
    document.fonts.ready.then(() => {
      const el = wordRef.current
      if (!el) return
      let max = 0
      for (const v of FONT_VARIANTS) {
        el.style.fontFamily    = v.fontFamily
        el.style.fontWeight    = v.fontWeight
        el.style.fontStyle     = v.fontStyle
        el.style.letterSpacing = v.letterSpacing
        el.style.textTransform = v.textTransform
        void el.offsetWidth
        max = Math.max(max, el.getBoundingClientRect().width)
      }
      // Restore first variant
      const v0 = FONT_VARIANTS[0]
      el.style.fontFamily    = v0.fontFamily
      el.style.fontWeight    = v0.fontWeight
      el.style.fontStyle     = v0.fontStyle
      el.style.letterSpacing = v0.letterSpacing
      el.style.textTransform = v0.textTransform
      setSlotW(Math.ceil(max) + 8)
      timerRef.current = setInterval(() => setFontIdx(i => (i + 1) % FONT_VARIANTS.length), 2400)
    })
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const v = FONT_VARIANTS[fontIdx]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        minHeight:      '100dvh',
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        gap:            32,
        padding:        24,
      }}
    >
      {/* Animated heading */}
      <div style={{ textAlign: 'center', lineHeight: 1.3 }}>
        <div style={{ fontSize: 'clamp(36px, 5.5vw, 74px)', fontWeight: 800, letterSpacing: '-.03em', color: 'var(--text)', whiteSpace: 'nowrap' }}>
          {'Сотвори '}
          <span ref={slotRef} style={{ display: 'inline-block', textAlign: 'center', verticalAlign: 'baseline', overflow: 'visible', width: slotW ? `${slotW}px` : undefined }}>
            <span
              ref={wordRef}
              style={{
                display:       'inline-block',
                color:         'var(--accent)',
                verticalAlign: 'baseline',
                fontFamily:    v.fontFamily,
                fontWeight:    v.fontWeight,
                fontStyle:     v.fontStyle,
                letterSpacing: v.letterSpacing,
                textTransform: v.textTransform as React.CSSProperties['textTransform'],
              }}
            >
              свой
            </span>
          </span>
        </div>
        <div style={{ fontSize: 'clamp(36px, 5.5vw, 74px)', fontWeight: 800, letterSpacing: '-.03em', color: 'var(--text)' }}>
          мультфильм
        </div>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 15, maxWidth: 360, textAlign: 'center' }}>
        Просто опиши историю — ИИ сделает остальное
      </p>

      <div style={{ display: 'flex', gap: 12 }}>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onRegister}
          style={{
            background:   'var(--accent)',
            color:        'var(--text-card)',
            borderRadius: 'var(--radius-pill)',
            padding:      '14px 40px',
            fontSize:     15,
            fontWeight:   800,
            boxShadow:    '0 7px 0 #7a9a00, 0 10px 24px rgba(0,0,0,.45)',
          }}
        >
          Начать бесплатно
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onLogin}
          style={{
            background:   'var(--bg-card)',
            color:        'var(--text)',
            borderRadius: 'var(--radius-pill)',
            padding:      '14px 32px',
            fontSize:     15,
            fontWeight:   600,
            border:       '1px solid var(--border)',
          }}
        >
          Войти
        </motion.button>
      </div>
    </motion.div>
  )
}
