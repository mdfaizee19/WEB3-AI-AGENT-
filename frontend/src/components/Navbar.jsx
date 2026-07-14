import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Logo from './Logo'
import CrooLogo from './CrooLogo'
import { C } from '../tokens'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [docsOpen, setDocsOpen] = useState(false)
  const loc = useLocation()
  const isHome = loc.pathname === '/'

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', h)
    return () => window.removeEventListener('scroll', h)
  }, [])

  return (
    <nav style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
      padding: '14px 0',
      background: scrolled ? 'rgba(0,0,0,.97)' : 'rgba(0,0,0,.85)',
      backdropFilter: 'blur(20px)',
      borderBottom: `1px solid ${scrolled ? C.border : 'transparent'}`,
      transition: 'all .3s',
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>

        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flexShrink: 0 }}>
          <Logo size={32} />
          <span style={{ fontSize: '1.15rem', fontWeight: 700, color: C.white,
            fontFamily: 'Times New Roman, serif', letterSpacing: '.02em' }}>Attestr</span>
        </Link>

        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <Link to="/dashboard"
            style={{ fontSize: '.88rem', color: loc.pathname === '/dashboard' ? C.green : C.muted,
              textDecoration: 'none', fontFamily: 'Times New Roman, serif', transition: 'color .2s' }}
            onMouseEnter={e => e.target.style.color = C.green}
            onMouseLeave={e => e.target.style.color = loc.pathname === '/dashboard' ? C.green : C.muted}>
            Dashboard
          </Link>
          {isHome && ['Services','Protocols','Roadmap'].map(l => (
            <a key={l} href={`#${l.toLowerCase()}`}
              style={{ fontSize: '.88rem', color: C.muted, textDecoration: 'none',
                fontFamily: 'Times New Roman, serif', transition: 'color .2s' }}
              onMouseEnter={e => e.target.style.color = C.green}
              onMouseLeave={e => e.target.style.color = C.muted}>{l}</a>
          ))}

          <div style={{ position: 'relative' }}
            onMouseEnter={() => setDocsOpen(true)}
            onMouseLeave={() => setDocsOpen(false)}>
            <span style={{ fontSize: '.88rem', color: loc.pathname.startsWith('/docs') ? C.green : C.muted,
              cursor: 'pointer', fontFamily: 'Times New Roman, serif',
              display: 'flex', alignItems: 'center', gap: 4 }}>
              Docs
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </span>
            {docsOpen && (
              <div style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                marginTop: 12, background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: 8, minWidth: 210,
                boxShadow: '0 16px 48px rgba(0,0,0,.9)', zIndex: 200 }}>
                {[
                  { to: '/docs/traders',    icon: '📈', label: 'Trader Docs',    sub: 'Vaults, research, risk' },
                  { to: '/docs/developers', icon: '⚙️', label: 'Developer Docs', sub: 'MCP, CAP, schemas, setup' },
                ].map(l => (
                  <Link key={l.to} to={l.to} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 8, textDecoration: 'none',
                    transition: 'background .15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = C.bg3}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ fontSize: '1rem' }}>{l.icon}</span>
                    <div>
                      <div style={{ fontSize: '.84rem', fontWeight: 700, color: C.white, fontFamily: 'Times New Roman, serif' }}>{l.label}</div>
                      <div style={{ fontSize: '.7rem', color: C.muted }}>{l.sub}</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="https://agent.croo.network/agents/20ba0841-8411-4ee7-960e-5b1d376943d3"
            target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center' }}>
            <CrooLogo square size={34} />
          </a>
          <a href="https://agent.croo.network/agents/20ba0841-8411-4ee7-960e-5b1d376943d3"
            target="_blank" rel="noreferrer"
            style={{ padding: '9px 20px', background: C.green, color: '#000',
              fontWeight: 700, fontSize: '.875rem', borderRadius: 6, textDecoration: 'none',
              fontFamily: 'Arial, sans-serif', transition: 'opacity .2s' }}
            onMouseEnter={e => e.currentTarget.style.opacity = '.85'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
            Try Agent →
          </a>
        </div>
      </div>
    </nav>
  )
}
