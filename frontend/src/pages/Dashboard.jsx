import { useState, useEffect, useCallback } from 'react'
import { C } from '../tokens'
import Navbar from '../components/Navbar'

const API_URL    = import.meta.env.VITE_COORDINATOR_URL ?? ''
const API_SECRET = import.meta.env.VITE_DASHBOARD_SECRET ?? ''

const SERVICE_COLORS = {
  'Research Query':      { bg: '#0a1a0a', border: C.green,  text: C.green  },
  'Contract Risk Check': { bg: '#0a0f1a', border: C.blue,   text: C.blue   },
  'Full Due Diligence':  { bg: '#1a0a1a', border: '#a855f7', text: '#a855f7' },
  'Hyperliquid Vault':   { bg: '#1a0d00', border: '#f97316', text: '#f97316' },
  'Risk Agent':          { bg: '#0a0f1a', border: C.blue,   text: C.blue   },
}

const STATUS_COLORS = {
  delivered:   { bg: '#0a1a0a', border: '#22c55e', text: '#22c55e' },
  paid:        { bg: '#0a1000', border: '#84cc16', text: '#84cc16' },
  negotiating: { bg: '#1a1000', border: '#eab308', text: '#eab308' },
  accepted:    { bg: '#1a1000', border: '#eab308', text: '#eab308' },
  rejected:    { bg: '#1a0a0a', border: '#ef4444', text: '#ef4444' },
  cancelled:   { bg: '#111',    border: '#555',    text: '#888'    },
}

function statusStyle(s) {
  return STATUS_COLORS[s] ?? { bg: '#111', border: '#444', text: '#888' }
}
function serviceStyle(s) {
  return SERVICE_COLORS[s] ?? { bg: '#111', border: '#444', text: '#888' }
}

function Badge({ label, style: s }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 99,
      fontSize: '.72rem', fontWeight: 700, letterSpacing: '.04em',
      background: s.bg, border: `1px solid ${s.border}`, color: s.text,
      textTransform: 'uppercase',
    }}>{label}</span>
  )
}

function fmtUptime(sec) {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

function shortId(id) {
  if (!id) return '—'
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

const headers = { Authorization: `Bearer ${API_SECRET}`, 'Content-Type': 'application/json' }

export default function Dashboard() {
  const [health, setHealth]   = useState(null)
  const [orders, setOrders]   = useState([])
  const [loadErr, setLoadErr] = useState(null)
  const [lastSync, setLastSync] = useState(null)
  const [loading, setLoading]   = useState(true)

  const refresh = useCallback(async () => {
    if (!API_URL) { setLoadErr('VITE_COORDINATOR_URL not set'); setLoading(false); return }
    try {
      const [hRes, oRes] = await Promise.all([
        fetch(`${API_URL}/health`,     { headers }),
        fetch(`${API_URL}/api/orders`, { headers }),
      ])
      if (hRes.status === 401 || oRes.status === 401) {
        setLoadErr('Invalid VITE_DASHBOARD_SECRET — check your Vercel env vars')
        setLoading(false)
        return
      }
      const h = await hRes.json()
      const o = await oRes.json()
      setHealth(h)
      setOrders(Array.isArray(o.orders) ? o.orders : [])
      setLoadErr(null)
      setLastSync(new Date())
    } catch (err) {
      setLoadErr(`Cannot reach coordinator: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 30_000)
    return () => clearInterval(iv)
  }, [refresh])

  const sorted = [...orders].sort((a, b) =>
    new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0)
  )

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.white }}>
      <Navbar />
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '100px 28px 60px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.6rem', fontFamily: 'Times New Roman, serif', fontWeight: 700 }}>
              Agent Dashboard
            </h1>
            <p style={{ margin: '4px 0 0', color: C.muted, fontSize: '.83rem' }}>
              {lastSync ? `Last synced ${timeAgo(lastSync.toISOString())}` : 'Loading…'} · auto-refreshes every 30s
            </p>
          </div>
          <button onClick={refresh} disabled={loading} style={{
            padding: '8px 18px', background: 'transparent', border: `1px solid ${C.border}`,
            color: loading ? C.faint : C.white2, borderRadius: 7, cursor: loading ? 'default' : 'pointer',
            fontSize: '.82rem', transition: 'border-color .2s',
          }}
            onMouseEnter={e => !loading && (e.currentTarget.style.borderColor = C.green)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = C.border)}
          >{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>

        {/* Error banner */}
        {loadErr && (
          <div style={{ padding: '12px 18px', background: '#1a0808', border: '1px solid #ef4444',
            borderRadius: 10, color: '#ef4444', fontSize: '.84rem', marginBottom: 24 }}>
            {loadErr}
          </div>
        )}

        {/* Status cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 32 }}>
          <StatCard label="Agent Status" value={
            health ? (
              <span style={{ color: health.status === 'online' ? C.green : '#ef4444', fontSize: '1rem', fontWeight: 700 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: health.status === 'online' ? C.green : '#ef4444',
                  marginRight: 7, boxShadow: health.status === 'online' ? `0 0 8px ${C.green}` : 'none' }} />
                {health.status.toUpperCase()}
              </span>
            ) : '—'
          } />
          <StatCard label="Uptime"         value={health ? fmtUptime(health.uptimeSeconds) : '—'} />
          <StatCard label="Active Orders"  value={health ? health.activeOrders : '—'} />
          <StatCard label="Total Orders"   value={loading ? '—' : orders.length} />
        </div>

        {/* Services */}
        {health?.services && (
          <div style={{ marginBottom: 32 }}>
            <SectionLabel>Active Services</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
              {health.services.map(s => (
                <div key={s} style={{
                  padding: '8px 16px', borderRadius: 8,
                  background: serviceStyle(s).bg, border: `1px solid ${serviceStyle(s).border}`,
                  color: serviceStyle(s).text, fontSize: '.82rem', fontWeight: 600,
                }}>{s}</div>
              ))}
            </div>
          </div>
        )}

        {/* Orders table */}
        <div>
          <SectionLabel>Order History</SectionLabel>
          {sorted.length === 0 && !loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: C.muted, fontSize: '.88rem' }}>
              No orders yet. Place an order on the{' '}
              <a href="https://agent.croo.network/agents/20ba0841-8411-4ee7-960e-5b1d376943d3"
                target="_blank" rel="noreferrer" style={{ color: C.green }}>CROO store</a>.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.83rem' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {['Order ID', 'Service', 'Status', 'Created', 'Amount'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left',
                        color: C.muted, fontWeight: 600, fontSize: '.75rem',
                        letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((o, i) => (
                    <tr key={o.orderId ?? i} style={{
                      borderBottom: `1px solid ${C.borderL}`,
                      transition: 'background .15s',
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = C.bg3}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '12px 14px', color: C.muted, fontFamily: 'monospace', fontSize: '.78rem' }}>
                        <span title={o.orderId}>{shortId(o.orderId)}</span>
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        <Badge label={o.serviceName ?? o.serviceId ?? '—'} style={serviceStyle(o.serviceName)} />
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        <Badge label={o.status ?? '—'} style={statusStyle(o.status)} />
                      </td>
                      <td style={{ padding: '12px 14px', color: C.muted, whiteSpace: 'nowrap' }}>
                        {timeAgo(o.createdAt)}
                      </td>
                      <td style={{ padding: '12px 14px', color: C.white2, whiteSpace: 'nowrap' }}>
                        {o.price ? `$${parseFloat(o.price).toFixed(2)}` : o.amount ? `$${parseFloat(o.amount).toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div style={{ padding: '18px 20px', background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: '.72rem', color: C.muted, textTransform: 'uppercase',
        letterSpacing: '.07em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{value}</div>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: '.72rem', color: C.muted, textTransform: 'uppercase',
      letterSpacing: '.1em', fontWeight: 700, marginBottom: 4 }}>{children}</div>
  )
}
