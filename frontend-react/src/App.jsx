import { Navigate, Route, Routes } from 'react-router-dom'
import SiteLayout from './components/SiteLayout.jsx'
import Home from './routes/Home.jsx'
import Login from './routes/Login.jsx'
import Signup from './routes/Signup.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        <Route path="/" element={<Home />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot" element={<Login initialMode="forgot" />} />
      <Route path="/reset" element={<Login initialMode="reset" />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
