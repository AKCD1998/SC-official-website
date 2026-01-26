import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export default function Navbar() {
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const navRef = useRef(null)
  const authRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    const handleScroll = () => {
      if (!navRef.current) return
      if (window.scrollY > 50) {
        navRef.current.classList.add('top-nav-collapse')
      } else {
        navRef.current.classList.remove('top-nav-collapse')
      }
    }
    handleScroll()
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!menuOpen) return
      if (authRef.current && !authRef.current.contains(event.target)) {
        setMenuOpen(false)
      }
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [menuOpen])

  const authEmail = user?.email || 'Account'

  const handleLogout = (event) => {
    event.preventDefault()
    logout()
    setMenuOpen(false)
    navigate('/')
    window.location.hash = 'top'
  }

  return (
    <section className="navbar custom-navbar navbar-fixed-top" role="navigation" ref={navRef}>
      <div className="container">
        <div className="navbar-header">
          <button
            className="navbar-toggle"
            type="button"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
          >
            <span className="icon icon-bar" />
            <span className="icon icon-bar" />
            <span className="icon icon-bar" />
          </button>
          <Link to="/" className="navbar-brand">
            SC Group 1989
          </Link>
        </div>

        <div className={`collapse navbar-collapse${navOpen ? ' in' : ''}`}>
          <ul className="nav navbar-nav navbar-nav-first">
            {[
              { href: '#top', label: 'หน้าแรก' },
              { href: '#about', label: 'ประกาศ' },
              { href: '#team', label: 'ทีมงานของเรา' },
              { href: '#JoinUs', label: 'ร่วมงานกับเรา' },
              { href: '#promotions', label: 'โปรโมชั่น' },
              { href: '#branches', label: 'สาขาของเรา' },
              { href: '#contact', label: 'ติดต่อเรา' },
            ].map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="smoothScroll"
                  onClick={() => setNavOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>

          <ul className="nav navbar-nav navbar-right">
            <li id="navAuth" className="sc-auth" ref={authRef}>
              {user ? (
                <a
                  href="#"
                  id="authLink"
                  onClick={(event) => {
                    event.preventDefault()
                    setMenuOpen((open) => !open)
                  }}
                >
                  <i className="fa fa-user" />
                  <span id="authText">{authEmail}</span>
                  <i
                    className="fa fa-caret-down"
                    id="authCaret"
                    style={{ display: 'inline-block', marginLeft: 6 }}
                  />
                </a>
              ) : (
                <Link id="authLink" to="/login">
                  <i className="fa fa-user" />
                  <span id="authText">Log in / sign up</span>
                </Link>
              )}

              <div
                id="authMenu"
                className="sc-auth-menu"
                style={{ display: menuOpen ? 'block' : 'none' }}
              >
                <a
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    alert('Coming soon 🙂')
                    setMenuOpen(false)
                  }}
                >
                  Edit profile (coming soon)
                </a>
                <a
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    alert('Coming soon 🙂')
                    setMenuOpen(false)
                  }}
                >
                  เชื่อมต่อบัญชี (coming soon)
                </a>
                <div className="sc-auth-divider" />
                <a href="#" id="menuLogout" onClick={handleLogout}>
                  <i className="fa fa-sign-out" /> Log out
                </a>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}
