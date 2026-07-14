import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home       from './pages/Home'
import TraderDocs from './pages/TraderDocs'
import DevDocs    from './pages/DevDocs'
import Dashboard  from './pages/Dashboard'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"                element={<Home />} />
        <Route path="/docs/traders"    element={<TraderDocs />} />
        <Route path="/docs/developers" element={<DevDocs />} />
        <Route path="/dashboard"       element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  )
}
