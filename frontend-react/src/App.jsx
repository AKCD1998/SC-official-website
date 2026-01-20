import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './routes/Home.jsx'
import LegacyFrame from './routes/LegacyFrame.jsx'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/index.html" element={<Home />} />
      <Route path="/html/login-form.html" element={<LegacyFrame path="/html/login-form.html" />} />
      <Route path="/html/sign-up-form.html" element={<LegacyFrame path="/html/sign-up-form.html" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
