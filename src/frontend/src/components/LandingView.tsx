import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

interface Props {
  onLogin:    () => void
  onRegister: () => void
}

export default function LandingView({ onLogin, onRegister }: Props) {
  const heroRef = useRef<HTMLDivElement>(null)

  // Parallax on hero section
  useEffect(() => {
    let raf: number
    const update = () => {
      const y = window.scrollY
      if (heroRef.current && y < window.innerHeight) {
        heroRef.current.style.transform = `translateY(${y * 0.4}px)`
      }
      raf = requestAnimationFrame(update)
    }
    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Intersection observer for reveal-on-scroll
  useEffect(() => {
    const els = document.querySelectorAll('.reveal-on-scroll')
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
          } else {
            entry.target.classList.remove('is-visible')
          }
        })
      },
      { threshold: 0.25 },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      style={{ overflowY: 'scroll', overflowX: 'hidden', width: '100vw', minHeight: '100vh' }}
    >
      <style>{landingCSS}</style>

      {/* HUD Layer — fixed overlay */}
      <div className="hud-layer">
        <div className="reg-mark reg-tl" />
        <div className="reg-mark reg-tr" />
        <div className="reg-mark reg-bl" />
        <div className="reg-mark reg-br" />

        <div className="data-overlay">SYS_TICK: 849.22 // LATENT_SPACE: STABLE</div>
        <div className="data-overlay data-overlay-right">RENDER_NODE: X-99 // MEM: 128TB ALLOCATED</div>

        <header className="hud-header">
          <div className="head-left">
            <span className="micro-type">OH_MY_TOON</span>
            <div className="line-horizontal" />
          </div>
          <div className="head-center micro-type">
            AI МУЛЬТФИЛЬМЫ И АНИМАЦИЯ
          </div>
          <div className="head-right">
            <div className="line-horizontal" />
            <nav className="auth-links micro-type">
              <a onClick={onLogin}>ВОЙТИ</a>
              <a onClick={onRegister}>РЕГИСТРАЦИЯ</a>
            </nav>
          </div>
        </header>
      </div>

      {/* Scroll content */}
      <div className="scroll-content">
        {/* Hero */}
        <section className="hero-section">
          <div className="parallax-target" ref={heroRef}>
            <h1 className="massive-text">СОЗДАЙ<br />МУЛЬТФИЛЬМ.</h1>
            <div className="subtext">СДЕЛАЙ МЕЧТУ РЕАЛЬНОСТЬЮ.</div>
          </div>

          <div className="cta-wrapper">
            <button className="cta-btn" onClick={onRegister}>
              НАЧАТЬ МУЛЬТИПЛИКАЦИЮ
              <svg className="arrow-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </div>
        </section>

        {/* Features */}
        <section className="features-section">
          <div className="feature-card reveal-on-scroll">
            <div className="feat-id-large">[01]</div>
            <div className="feat-content">
              <h2>РАЗНЫЕ СТИЛИ АНИМАЦИИ</h2>
              <p>Аниме, мультфильм, Pixar 3D — выбери визуальный стиль и ИИ адаптирует каждый кадр. Переключайся между стилями в один клик.</p>
            </div>
          </div>

          <div className="feature-card reveal-on-scroll">
            <div className="feat-id-large">[02]</div>
            <div className="feat-content">
              <h2>ХРАНЕНИЕ В ОБЛАКЕ</h2>
              <p>Все изображения, клипы и финальные видео надёжно хранятся в облаке. Скачивай готовый результат в любой момент без потери качества.</p>
            </div>
          </div>

          <div className="feature-card reveal-on-scroll">
            <div className="feat-id-large">[03]</div>
            <div className="feat-content">
              <h2>НАСТРОЙКА НА КАЖДОМ ЭТАПЕ</h2>
              <p>Редактируй промпты, пересоздавай отдельные кадры, утверждай фреймы перед генерацией видео. Полный контроль над каждой сценой.</p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="final-cta-section reveal-on-scroll">
          <h1 className="massive-text">ИНИЦИАЛИЗАЦИЯ</h1>
          <div className="auth-buttons-large">
            <button
              className="cta-btn"
              style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)' }}
              onClick={onRegister}
            >
              РЕГИСТРАЦИЯ
            </button>
            <button className="cta-btn" onClick={onLogin}>
              ВОЙТИ В СИСТЕМУ
              <svg className="arrow-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </div>
        </section>

        {/* Footer */}
        <footer className="site-footer">
          <span>&copy; 2025 // OHMYTOON</span>
          <span className="footer-brand">OH_MY_TOON PROTOCOL</span>
        </footer>
      </div>
    </motion.div>
  )
}

const landingCSS = `
  .hud-layer {
    position: fixed;
    top: 2rem;
    left: 2rem;
    right: 2rem;
    bottom: 2rem;
    pointer-events: none;
    z-index: 100;
  }

  .hud-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    pointer-events: auto;
    align-items: center;
  }

  .reg-mark {
    position: absolute;
    width: 10px;
    height: 10px;
    border-color: var(--text-muted);
    border-style: solid;
    opacity: 0.5;
    pointer-events: none;
  }
  .reg-tl { top: -10px; left: -10px; border-width: 1px 0 0 1px; }
  .reg-tr { top: -10px; right: -10px; border-width: 1px 1px 0 0; }
  .reg-bl { bottom: -10px; left: -10px; border-width: 0 0 1px 1px; }
  .reg-br { bottom: -10px; right: -10px; border-width: 0 1px 1px 0; }

  .micro-type {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.15em;
    color: var(--accent);
    white-space: nowrap;
  }

  .line-horizontal {
    height: 1px;
    background-color: var(--accent);
    width: 100%;
    opacity: 0.8;
    align-self: center;
  }

  .head-left { display: flex; align-items: center; gap: 1rem; }
  .head-center { padding: 0 1.5rem; color: var(--accent); }
  .head-right { display: flex; align-items: center; justify-content: flex-end; gap: 1rem; }

  .auth-links { display: flex; gap: 1.5rem; }
  .auth-links a {
    color: var(--accent);
    text-decoration: none;
    transition: color 0.2s;
    cursor: pointer;
  }
  .auth-links a:hover { color: var(--text); }
  .auth-links a::before { content: '['; margin-right: 0.3em; opacity: 0.5; }
  .auth-links a::after { content: ']'; margin-left: 0.3em; opacity: 0.5; }

  .data-overlay {
    position: absolute;
    top: 50%;
    left: -2rem;
    transform: translateY(-50%) rotate(-90deg);
    color: var(--text-muted);
    font-size: 0.55rem;
    letter-spacing: 0.2em;
    opacity: 0.3;
  }
  .data-overlay-right {
    left: auto;
    right: -2rem;
    transform: translateY(-50%) rotate(90deg);
  }

  .scroll-content {
    position: relative;
    z-index: 10;
    padding: 2rem;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .hero-section {
    height: calc(100vh - 4rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .parallax-target {
    display: flex;
    flex-direction: column;
    align-items: center;
    will-change: transform;
  }

  .massive-text {
    font-family: var(--font-display);
    font-size: clamp(4rem, 15vw, 18rem);
    line-height: 0.85;
    color: var(--text);
    margin: 0;
    text-align: center;
    letter-spacing: -0.02em;
    text-shadow:
      3px 3px 0px rgba(212, 255, 69, 0.2),
      -1px -1px 0px rgba(255, 255, 255, 0.1);
    position: relative;
    cursor: default;
    transition: color 0.3s ease;
  }
  .massive-text:hover {
    color: var(--accent);
    text-shadow: none;
  }

  .subtext {
    margin-top: 1.5rem;
    color: var(--text-muted);
    letter-spacing: 0.4em;
    font-size: 0.85rem;
  }

  .cta-wrapper {
    position: relative;
    margin-top: 4rem;
    z-index: 20;
  }

  .cta-btn {
    background-color: var(--accent);
    color: var(--bg);
    border: none;
    padding: 1.2rem 2.5rem;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 1rem;
    transition: transform 0.1s, background-color 0.2s;
  }
  .cta-btn:hover {
    transform: translate(-4px, -4px);
    background-color: #e0ff66;
  }
  .cta-btn::before {
    content: '';
    position: absolute;
    top: 4px;
    left: 4px;
    right: -4px;
    bottom: -4px;
    background-color: transparent;
    border: 1px solid var(--accent);
    z-index: -1;
    transition: all 0.1s;
  }
  .cta-btn:hover::before {
    top: 8px;
    left: 8px;
    right: -8px;
    bottom: -8px;
  }

  .arrow-icon {
    width: 16px;
    height: 16px;
  }

  .features-section {
    padding: 15vh 0;
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 20vh;
  }

  .feature-card {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 3rem;
    align-items: start;
    opacity: 0;
    transform: translateX(100px);
    transition: opacity 1s cubic-bezier(0.16, 1, 0.3, 1), transform 1s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .feature-card.is-visible {
    opacity: 1;
    transform: translateX(0);
  }

  .feature-card:nth-child(even) {
    margin-left: 10%;
  }

  .feat-id-large {
    font-family: var(--font-mono);
    font-size: 2.5rem;
    color: var(--accent);
    line-height: 0.9;
  }

  .feat-content h2 {
    font-family: var(--font-display);
    font-size: clamp(2.5rem, 6vw, 5rem);
    color: var(--text);
    margin-bottom: 1.5rem;
    line-height: 0.9;
    letter-spacing: -0.01em;
  }

  .feat-content p {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 1.25rem;
    color: var(--text-muted);
    max-width: 600px;
    line-height: 1.6;
    text-transform: none;
  }

  .final-cta-section {
    padding: 15vh 0 10vh 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    border-top: 1px solid rgba(212, 255, 69, 0.1);
    margin-top: 10vh;
  }

  .final-cta-section .massive-text {
    font-size: clamp(3rem, 10vw, 8rem);
    margin-bottom: 4rem;
  }

  .auth-buttons-large {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .site-footer {
    margin-top: auto;
    padding-top: 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px dashed rgba(102, 102, 102, 0.3);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.15em;
    color: var(--text-muted);
  }

  .footer-brand { color: var(--accent); }
`
