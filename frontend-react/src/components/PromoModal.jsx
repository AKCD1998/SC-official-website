import { useEffect, useRef, useState } from 'react'

const MIN_SCALE = 1
const MAX_SCALE = 4

export default function PromoModal({ open, image, onClose }) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const stageRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    document.body.classList.add('promo-modal-open')
    return () => document.body.classList.remove('promo-modal-open')
  }, [open, image])

  useEffect(() => {
    if (!open) return undefined
    const handleMove = (event) => {
      if (!dragging.current) return
      const x = event.clientX - dragStart.current.x
      const y = event.clientY - dragStart.current.y
      setTranslate({ x, y })
    }
    const handleUp = () => {
      dragging.current = false
      if (stageRef.current) stageRef.current.classList.remove('is-dragging')
    }
    const handleEsc = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open, onClose])

  const setClampedScale = (next) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next))
    setScale(clamped)
    if (clamped === MIN_SCALE) {
      setTranslate({ x: 0, y: 0 })
    }
  }

  if (!open) return null

  return (
    <div
      id="promoModal"
      className={`promo-modal${open ? ' is-open' : ''}`}
      aria-hidden={open ? 'false' : 'true'}
    >
      <div className="promo-modal-backdrop" data-action="close" onClick={onClose} />
      <div className="promo-modal-dialog" role="dialog" aria-modal="true" aria-label="Promotion image">
        <button
          type="button"
          className="promo-modal-close"
          data-action="close"
          aria-label="Close"
          onClick={onClose}
        >
          &times;
        </button>
        <div className="promo-modal-toolbar">
          <button
            type="button"
            className="promo-modal-btn"
            data-action="zoom-out"
            aria-label="Zoom out"
            onClick={() => setClampedScale(scale - 0.2)}
          >
            -
          </button>
          <button
            type="button"
            className="promo-modal-btn"
            data-action="zoom-reset"
            aria-label="Reset zoom"
            onClick={() => setClampedScale(1)}
          >
            100%
          </button>
          <button
            type="button"
            className="promo-modal-btn"
            data-action="zoom-in"
            aria-label="Zoom in"
            onClick={() => setClampedScale(scale + 0.2)}
          >
            +
          </button>
        </div>
        <div className="promo-modal-stage" ref={stageRef}>
          <img
            id="promoModalImg"
            className="promo-modal-img"
            src={image?.src}
            alt={image?.alt || ''}
            draggable="false"
            onMouseDown={(event) => {
              if (scale <= 1) return
              dragging.current = true
              dragStart.current = {
                x: event.clientX - translate.x,
                y: event.clientY - translate.y,
              }
              stageRef.current?.classList.add('is-dragging')
            }}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
