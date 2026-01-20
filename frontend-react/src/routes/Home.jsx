import { useEffect, useState } from 'react'

const LEGACY_HTML_PATH = '/legacy/index.html'
const LEGACY_SCRIPTS = [
  '/js/jquery.js',
  '/js/bootstrap.min.js',
  '/js/owl.carousel.min.js',
  '/js/monthPromo.js',
  '/js/smoothscroll.js',
  '/js/custom.js',
  '/js/contact.js',
  '/js/map.js',
  '/js/auth-navbar.js?v=1',
]

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = src
    script.async = false
    script.onload = resolve
    script.onerror = reject
    document.body.appendChild(script)
  })
}

export default function Home() {
  const [markup, setMarkup] = useState('')

  useEffect(() => {
    let isCancelled = false

    fetch(LEGACY_HTML_PATH)
      .then((res) => res.text())
      .then((html) => {
        if (isCancelled) return
        const doc = new DOMParser().parseFromString(html, 'text/html')
        doc.querySelectorAll('script').forEach((script) => script.remove())
        const title = doc.querySelector('title')?.textContent?.trim()
        if (title) document.title = title
        setMarkup(doc.body.innerHTML)
      })
      .catch((error) => {
        console.error('Failed to load legacy HTML:', error)
      })

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!markup) return
    if (window.__legacyHomeScriptsLoaded) return
    window.__legacyHomeScriptsLoaded = true

    const loadAll = async () => {
      for (const src of LEGACY_SCRIPTS) {
        await loadScript(src)
      }
      if (window.jQuery) {
        window.jQuery(window).trigger('load')
      }
    }

    loadAll().catch((error) => {
      console.error('Failed to load legacy scripts:', error)
    })
  }, [markup])

  return <div id="legacy-home" dangerouslySetInnerHTML={{ __html: markup }} />
}
