import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import useBodyClass from '../hooks/useBodyClass.js'

export default function Login({ initialMode = 'login' }) {
  useBodyClass('page-login')
  const navigate = useNavigate()
  const { setToken } = useAuth()

  const [mode, setMode] = useState(initialMode)
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginMsg, setLoginMsg] = useState({ text: '', type: '' })

  const [fpEmail, setFpEmail] = useState('')
  const [fpOtp, setFpOtp] = useState('')
  const [fpMsg, setFpMsg] = useState({ text: '', isError: true })
  const [resetToken, setResetToken] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetMsg, setResetMsg] = useState({ text: '', isError: true })

  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  useEffect(() => {
    const titles = {
      login: 'Log in',
      forgot: 'Forgot password',
      reset: 'Reset password',
    }
    document.title = titles[mode] || 'Log in'
  }, [mode])

  const handleLogin = async (event) => {
    event.preventDefault()
    setLoginMsg({ text: '', type: '' })

    try {
      setLoading(true)
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoginMsg({ text: data.error || 'Login failed', type: 'error' })
        return
      }

      setToken(data.token)
      setLoginMsg({ text: 'Login success ✅', type: 'success' })
      navigate('/')
      window.location.hash = 'top'
    } catch (error) {
      setLoginMsg({ text: 'Network error / server error', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleForgotClick = (event) => {
    event.preventDefault()
    setFpMsg({ text: '', isError: true })
    setResetMsg({ text: '', isError: true })
    setResetToken(null)
    setMode('forgot')
    setFpEmail(email.trim())
  }

  const handleSendOtp = async () => {
    setFpMsg({ text: '', isError: true })
    const trimmed = fpEmail.trim()
    if (!trimmed) {
      setFpMsg({ text: 'กรุณากรอกอีเมล์', isError: true })
      return
    }

    try {
      setLoading(true)
      setFpMsg({ text: 'กำลังส่ง OTP...', isError: false })
      const res = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFpMsg({ text: data.error || 'ส่ง OTP ไม่สำเร็จ', isError: true })
        return
      }
      setFpMsg({ text: 'ส่ง OTP แล้ว ✅ กรุณาเช็คอีเมล์', isError: false })
    } catch (error) {
      setFpMsg({ text: 'Network error / server error', isError: true })
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async () => {
    setFpMsg({ text: '', isError: true })
    const trimmed = fpEmail.trim()
    if (!trimmed) return setFpMsg({ text: 'กรุณากรอกอีเมล์', isError: true })
    if (!fpOtp.trim()) return setFpMsg({ text: 'กรุณากรอก OTP', isError: true })

    try {
      setLoading(true)
      setFpMsg({ text: 'กำลังตรวจสอบ OTP...', isError: false })
      const res = await apiFetch('/api/auth/verify-reset-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, otp: fpOtp.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFpMsg({ text: data.error || 'OTP ไม่ถูกต้อง', isError: true })
        return
      }
      setResetToken(data.resetToken)
      setMode('reset')
      setResetMsg({ text: 'OTP ถูกต้อง ✅ ตั้งรหัสผ่านใหม่ได้เลย', isError: false })
    } catch (error) {
      setFpMsg({ text: 'Network error / server error', isError: true })
    } finally {
      setLoading(false)
    }
  }

  const handleResetPassword = async (event) => {
    event.preventDefault()
    setResetMsg({ text: '', isError: true })

    if (!resetToken) {
      setResetMsg({ text: 'ไม่มี resetToken (กรุณายืนยัน OTP ใหม่)', isError: true })
      return
    }
    if (newPassword.length < 8) {
      setResetMsg({ text: 'รหัสผ่านต้องอย่างน้อย 8 ตัว', isError: true })
      return
    }
    if (newPassword !== confirmPassword) {
      setResetMsg({ text: 'รหัสผ่านไม่ตรงกัน', isError: true })
      return
    }

    try {
      setLoading(true)
      setResetMsg({ text: 'กำลังรีเซ็ตรหัสผ่าน...', isError: false })
      const res = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: fpEmail.trim(),
          resetToken,
          newPassword,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResetMsg({ text: data.error || 'รีเซ็ตไม่สำเร็จ', isError: true })
        return
      }

      setResetMsg({ text: 'รีเซ็ตรหัสผ่านเรียบร้อย ✅ ไปล็อกอินได้เลย', isError: false })
      setMode('login')
    } catch (error) {
      setResetMsg({ text: 'Network error / server error', isError: true })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="auth-wrap" id="loginWrap" style={{ display: mode === 'login' ? 'flex' : 'none' }}>
        <div className="auth-card">
          <div className="auth-head">
            <h2>Log in</h2>
            <p>เข้าสู่ระบบเพื่อใช้งาน</p>
          </div>

          <div className="auth-body">
            <form id="loginForm" onSubmit={handleLogin}>
              <div className="form-group">
                <label htmlFor="email" className="small text-muted">
                  Email
                </label>
                <div className="input-group">
                  <span className="input-group-addon">
                    <i className="fa fa-envelope" />
                  </span>
                  <input
                    id="email"
                    type="email"
                    name="email"
                    className="form-control"
                    placeholder="your@email.com"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginTop: 12 }}>
                <label htmlFor="password" className="small text-muted">
                  Password
                </label>
                <div className="input-group">
                  <span className="input-group-addon">
                    <i className="fa fa-lock" />
                  </span>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    className="form-control"
                    placeholder="Your password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <span
                    className="input-group-addon toggle-pass"
                    id="togglePass"
                    title="Show/Hide"
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    <i className={`fa ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`} />
                  </span>
                </div>
              </div>

              <button type="submit" className="btn-primary-auth" id="form-submit" style={{ marginTop: 14 }}>
                Log in
              </button>

              <div className="auth-links">
                <Link id="goSignup" to="/signup">
                  <i className="fa fa-user-plus" /> Create account
                </Link>
                <a href="#" id="goForgot" onClick={handleForgotClick}>
                  <i className="fa fa-question-circle" /> Forgot password
                </a>
              </div>
            </form>

            <p id="msg" className={loginMsg.type === 'success' ? 'ok' : loginMsg.type === 'error' ? 'err' : ''}>
              {loginMsg.text}
            </p>
          </div>
        </div>
      </div>

      <div
        id="otpForgotPass"
        className="otp-wrap"
        style={{ display: mode === 'forgot' ? 'flex' : 'none', flexDirection: 'column' }}
      >
        <div className="otp-title">
          <i className="fa fa-shield" /> ยืนยันอีเมล์ (OTP)
        </div>

        <div className="input-head">
          <span className="input-group-addon">
            <i className="fa fa-envelope" />
          </span>
          <label className="label" htmlFor="fpEmail">
            อีเมล์
          </label>
        </div>
        <input
          id="fpEmail"
          type="email"
          name="email"
          className="form-control"
          placeholder="your@email.com"
          required
          value={fpEmail}
          onChange={(event) => setFpEmail(event.target.value)}
        />
        <button
          id="fpSendBtn"
          className="submit-btn form-control"
          type="button"
          style={{ marginTop: 10 }}
          onClick={handleSendOtp}
        >
          ส่งรหัส OTP
        </button>

        <div className="input-head">
          <span className="input-group-addon">
            <i className="fa fa-key" />
          </span>
          <label className="label" htmlFor="fpOtp">
            OTP ระบบจะส่งรหัสไปที่อีเมล์ของคุณ{' '}
            <a className="resendOTP" href="#" onClick={(event) => event.preventDefault() || handleSendOtp()}>
              ส่งอีกครั้ง
            </a>
          </label>
        </div>
        <input
          id="fpOtp"
          type="text"
          className="form-control"
          placeholder="6-digit code"
          inputMode="numeric"
          maxLength={6}
          value={fpOtp}
          onChange={(event) => setFpOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />

        <button
          id="fpVerifyBtn"
          className="submit-btn form-control"
          type="button"
          style={{ marginTop: 10 }}
          onClick={handleVerifyOtp}
        >
          ยืนยันอีเมล์
        </button>
        <p id="fpMsg" style={{ color: fpMsg.isError ? 'crimson' : 'green' }}>
          {fpMsg.text}
        </p>
      </div>

      <div
        id="otpResetPass"
        className="resetPass otp-wrap"
        style={{ display: mode === 'reset' ? 'flex' : 'none', flexDirection: 'column' }}
      >
        <form id="resetForm" onSubmit={handleResetPassword}>
          <div className="otp-title">
            <i className="fa fa-key" /> ตั้งรหัสผ่านใหม่
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label htmlFor="fpNewPassword" className="small text-muted">
              ตั้งรหัสผ่านใหม่
            </label>
            <div className="input-group">
              <span className="input-group-addon">
                <i className="fa fa-lock" />
              </span>
              <input
                id="fpNewPassword"
                type={showNewPassword ? 'text' : 'password'}
                className="form-control"
                placeholder="New password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <span
                className="input-group-addon toggle-pass"
                id="fpToggleNew"
                title="Show/Hide"
                onClick={() => setShowNewPassword((prev) => !prev)}
              >
                <i className={`fa ${showNewPassword ? 'fa-eye-slash' : 'fa-eye'}`} />
              </span>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label htmlFor="fpConfirmPassword" className="small text-muted">
              ยืนยันรหัสผ่านใหม่
            </label>
            <div className="input-group">
              <span className="input-group-addon">
                <i className="fa fa-lock" />
              </span>
              <input
                id="fpConfirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                className="form-control"
                placeholder="Confirm new password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <span
                className="input-group-addon toggle-pass"
                id="fpToggleConfirm"
                title="Show/Hide"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
              >
                <i className={`fa ${showConfirmPassword ? 'fa-eye-slash' : 'fa-eye'}`} />
              </span>
            </div>
          </div>

          <button type="submit" className="submit-btn form-control" id="fpResetBtn">
            รีเซ็ตรหัสผ่าน
          </button>

          <p id="fpResetMsg" style={{ color: resetMsg.isError ? 'crimson' : 'green' }}>
            {resetMsg.text}
          </p>
        </form>
      </div>

      <div id="loadingOverlay" className={`loading-overlay${loading ? ' is-on' : ''}`} aria-hidden={!loading}>
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    </>
  )
}
