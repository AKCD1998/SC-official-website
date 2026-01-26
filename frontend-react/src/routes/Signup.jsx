import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api.js'
import useBodyClass from '../hooks/useBodyClass.js'

function cleanDigits(value, maxLen = 10) {
  return (value || '').replace(/\D/g, '').slice(0, maxLen)
}

function formatThaiPhone(rawDigits) {
  if (!rawDigits) return ''
  const digits = cleanDigits(rawDigits)

  if (digits.length >= 3 && ['6', '8', '9'].includes(digits[1])) {
    return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 10)]
      .filter(Boolean)
      .join('-')
  }

  return [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 9)]
    .filter(Boolean)
    .join('-')
}

function isValidThaiPhone(value) {
  const digits = cleanDigits(value)
  const isMobile = /^0[689]\d{8}$/.test(digits)
  const isLandline = /^0[2-7]\d{7}$/.test(digits)
  return isMobile || isLandline
}

function isValidEmail(email) {
  if (!email) return false
  const trimmed = email.trim()
  const basicPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
  if (!basicPattern.test(trimmed)) return false

  const domain = trimmed.split('@')[1]
  if (!domain || domain.includes('..')) return false
  const parts = domain.split('.')
  return parts.every((part) => part && !part.startsWith('-') && !part.endsWith('-'))
}

function isStrongPassword(password) {
  if (!password) return false
  const strongPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,30}$/
  return strongPattern.test(password)
}

export default function Signup() {
  useBodyClass('page-signup')
  const navigate = useNavigate()

  const [step, setStep] = useState('form')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [message, setMessage] = useState({ text: '', isError: false })
  const [otp, setOtp] = useState('')
  const [form, setForm] = useState({
    fullName: '',
    phoneNumber: '',
    email: '',
    password: '',
    confirmPassword: '',
  })

  useEffect(() => {
    document.title = 'Sign up'
  }, [])

  const setMsg = (text, isError = false) => {
    setMessage({ text, isError })
  }

  const validateAllFields = () => {
    const { fullName, email, password, confirmPassword, phoneNumber } = form
    const phoneDigits = cleanDigits(phoneNumber)

    if (!fullName || !email || !password || !confirmPassword || !phoneDigits) {
      return { ok: false, message: 'กรอกข้อมูลให้ครบทุกช่องก่อนดำเนินการ' }
    }

    if (!isValidThaiPhone(phoneDigits)) {
      return {
        ok: false,
        message: 'กรุณากรอกเบอร์โทรศัพท์ไทยให้ถูกต้อง (มือถือ 10 หลัก หรือเบอร์บ้าน 9 หลัก)',
      }
    }

    if (!isValidEmail(email)) {
      return { ok: false, message: 'กรุณากรอกอีเมล์ที่โดเมนใช้งานได้จริง' }
    }

    if (!isStrongPassword(password)) {
      return {
        ok: false,
        message: 'รหัสผ่านต้องยาว 8-30 ตัว และมีตัวพิมพ์ใหญ่ พิมพ์เล็ก และตัวเลข',
      }
    }

    if (confirmPassword !== password) {
      return { ok: false, message: 'รหัสผ่านและยืนยันรหัสผ่านต้องตรงกัน' }
    }

    return { ok: true, cleanedPhone: phoneDigits }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setMsg('')

    const validation = validateAllFields()
    if (!validation.ok) return setMsg(validation.message, true)

    try {
      setLoading(true)
      setMsg('Sending verification code...')

      const res = await apiFetch('/api/auth/start-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email.trim() }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to send code')

      setStep('otp')
      setMsg('✅ Code sent. Check your email and enter the 6-digit code.')
    } catch (error) {
      setMsg(`❌ ${error.message}`, true)
    } finally {
      setLoading(false)
    }
  }

  const handleVerify = async () => {
    setMsg('')
    const validation = validateAllFields()
    if (!validation.ok) return setMsg(validation.message, true)

    if (!otp.trim()) return setMsg('Enter the 6-digit code.', true)

    try {
      setLoading(true)
      setMsg('Verifying code...')

      const res = await apiFetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email.trim(), code: otp.trim() }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Verification failed')

      setMsg('✅ Email verified. Creating account...')

      const res2 = await apiFetch('/api/auth/finish-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          password: form.password,
          phoneNumber: validation.cleanedPhone,
        }),
      })

      const data2 = await res2.json()
      if (!res2.ok) throw new Error(data2.error || 'Finish signup failed')

      setMsg('✅ Account created! You can now log in.')
      navigate('/login')
    } catch (error) {
      setMsg(`❌ ${error.message}`, true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="auth-wrap" id="signupWrap" style={{ display: step === 'form' ? 'block' : 'none' }}>
        <div className="auth-card">
          <div className="auth-head">
            <h2>ลงทะเบียน</h2>
            <p>สร้างบัญชีใหม่เพื่อใช้งานระบบของ SC</p>
          </div>

          <div className="auth-body">
            <form id="signupForm" onSubmit={handleSubmit}>
              <div className="input-head">
                <span className="input-group-addon">
                  <i className="fa fa-user" />
                </span>
                <label className="label">ชื่อ-นามสกุล</label>
              </div>

              <input
                id="fullName"
                type="text"
                name="fullName"
                className="form-control"
                placeholder="Full name"
                required
                value={form.fullName}
                onChange={(event) => setForm((prev) => ({ ...prev, fullName: event.target.value }))}
              />

              <div className="input-head">
                <span className="input-group-addon">
                  <i className="fa fa-phone" />
                </span>
                <label className="label">เบอร์โทรศัพท์</label>
              </div>

              <input
                id="phoneNumber"
                type="text"
                name="phoneNumber"
                className="form-control"
                placeholder="Your phone number"
                required
                value={form.phoneNumber}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, phoneNumber: formatThaiPhone(event.target.value) }))
                }
              />

              <div className="help">ตัวอย่าง: 08x-xxx-xxxx</div>

              <div className="input-head">
                <span className="input-group-addon">
                  <i className="fa fa-envelope" />
                </span>
                <label className="label">อีเมล์</label>
              </div>

              <input
                id="email"
                type="email"
                name="email"
                className="form-control"
                placeholder="your@email.com"
                required
                value={form.email}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              />

              <div className="input-head">
                <span className="input-group-addon">
                  <i className="fa fa-lock" />
                </span>
                <label className="label">รหัสผ่าน</label>
              </div>

              <div className="input-group">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  className="form-control"
                  placeholder="Your password"
                  required
                  value={form.password}
                  onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                />
                <span className="toggle-pass" id="togglePass" title="Show/Hide" onClick={() => setShowPassword((prev) => !prev)}>
                  <i className={`fa ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`} />
                </span>
              </div>

              <div className="input-head">
                <span className="input-group-addon">
                  <i className="fa fa-lock" />
                </span>
                <label className="label">ยืนยันรหัสผ่าน</label>
              </div>

              <div className="input-group">
                <input
                  id="confirmPassword"
                  type={showConfirm ? 'text' : 'password'}
                  name="confirmPassword"
                  className="form-control"
                  placeholder="Confirm your password"
                  required
                  value={form.confirmPassword}
                  onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
                />
                <span
                  className="toggle-pass"
                  id="toggleConfirmPass"
                  title="Show/Hide"
                  onClick={() => setShowConfirm((prev) => !prev)}
                >
                  <i className={`fa ${showConfirm ? 'fa-eye-slash' : 'fa-eye'}`} />
                </span>
              </div>

              <button type="submit" className="submit-btn form-control" id="form-submit" disabled={loading}>
                สร้างบัญชี
              </button>

              <div className="tiny-links">
                <Link to="/login">
                  <i className="fa fa-sign-in" /> มีบัญชีแล้ว? เข้าสู่ระบบ
                </Link>
                <Link to="/">
                  <i className="fa fa-home" /> กลับหน้าแรก
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>

      <div id="otpBox" className="otp-wrap" style={{ display: step === 'otp' ? 'block' : 'none' }}>
        <div className="otp-title">
          <i className="fa fa-shield" /> ยืนยันอีเมล์ (OTP)
        </div>

        <div className="input-head">
          <span className="input-group-addon">
            <i className="fa fa-key" />
          </span>
          <input
            id="otp"
            type="text"
            className="form-control"
            placeholder="6-digit code"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(event) => setOtp(cleanDigits(event.target.value, 6))}
          />
        </div>

        <button id="verifyBtn" className="submit-btn form-control" type="button" style={{ marginTop: 10 }} onClick={handleVerify}>
          ยืนยันอีเมล์
        </button>
        <div className="help">ระบบจะส่งรหัสไปที่อีเมล์ของคุณ</div>
      </div>

      <p id="msg" className={message.isError ? 'is-error shake' : ''}>
        {message.text}
      </p>
    </>
  )
}
