import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import PromoModal from '../components/PromoModal.jsx'
import { apiFetch } from '../lib/api.js'

const BASE_URL = import.meta.env.BASE_URL || '/'
const assetUrl = (path) => `${BASE_URL}${path.replace(/^\/+/, '')}`

const heroSlides = [
  {
    id: 'slide-1',
    className: 'item item-first',
    link: 'https://lin.ee/2QkD9Vn',
    linkClass: 'slide-link',
    label: 'Open LINE OA',
  },
  {
    id: 'slide-2',
    className: 'item item-second',
    link: 'https://lin.ee/dWDmwRv',
    linkClass: 'slide-overlay-link',
    label: 'Open LINE link',
  },
  {
    id: 'slide-3',
    className: 'item item-third',
  },
]

const teamMembers = [
  { name: 'ภก.ทรงพล ลิ้มพิสูจน์', image: assetUrl('images/BenzRx.png') },
  { name: 'ภญ.ณัฐพัชร กระจ่าง', image: assetUrl('images/NKRx.jpg') },
  { name: 'ภก.ชวิศ ดิษฐาพร', image: assetUrl('images/AuuRx.png') },
  { name: 'ภญ. ศุภิสรา ศิริมงคล', image: assetUrl('images/AmpRx.jpg') },
  { name: 'ภญ. มณีรัตน์ มาลัยมาลย์', image: assetUrl('images/JaaRx.jpg') },
]

const courses = [
  {
    image: assetUrl('images/courses-image1.jpg'),
    date: '12 / 7 / 2018',
    duration: '7 Hours',
    title: 'ร้านยาศิริชัยเภสัช รับบริการสิทธิ์บัตรทอง',
    desc: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    authorImage: assetUrl('images/author-image1.jpg'),
  },
  {
    image: assetUrl('images/courses-image2.jpg'),
    date: '20 / 7 / 2018',
    duration: '4.5 Hours',
    title: 'ศิริชัยเภสัช เข้าร่วมโครงการสาธารณสุข',
    desc: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    authorImage: assetUrl('images/author-image2.jpg'),
  },
  {
    image: assetUrl('images/courses-image4.jpg'),
    date: '10 / 8 / 2018',
    duration: '8 Hours',
    title: 'Summer Kids',
    desc: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    authorImage: assetUrl('images/author-image1.jpg'),
  },
  {
    image: assetUrl('images/courses-image5.jpg'),
    date: '5 / 10 / 2018',
    duration: '10 Hours',
    title: 'Business & Management',
    desc: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    authorImage: assetUrl('images/author-image2.jpg'),
  },
]

const branches = [
  {
    id: 'hq',
    name: 'ศิริชัยเภสัช สาขาตลาดบางน้อย',
    title: 'บริษัท เอสซีกรุ๊ป (1989) จำกัด',
    hours: 'เปิด 08:00–17:00 น.',
    phone: '086-410-1454',
    lat: '13.3968',
    lng: '100.0037',
    isHQ: true,
  },
  {
    id: 'maeklong',
    name: 'ศิริชัยเภสัช สาขาตลาดแม่กลอง',
    title: 'ศิริชัยเภสัช สาขาตลาดแม่กลอง',
    hours: 'เปิดทุกวัน 07:00–21:00 น.',
    phone: '092-997-9779',
    lat: '13.4068',
    lng: '100.0004',
  },
  {
    id: 'watchonglom',
    name: 'ศิริชัยเภสัช สาขาวัดช่องลม',
    title: 'ศิริชัยเภสัช สาขาวัดช่องลม',
    hours: 'เปิดทุกวัน 08:00–20:00 น.',
    phone: '098-861-5900',
    lat: '13.4192',
    lng: '99.9787',
  },
  {
    id: 'bangnoi',
    name: 'ศิริชัยเภสัช สาขาตลาดบางน้อย',
    title: 'ศิริชัยเภสัช สาขาตลาดบางน้อย',
    hours: 'เปิดทุกวัน 08:00–20:00 น.',
    phone: '062-180-6912',
    lat: '13.4607',
    lng: '99.9454',
  },
]

const promoImages = Array.from({ length: 38 }).map((_, idx) => {
  const num = idx + 1
  const filename = num === 1 ? 'promo.jpg' : `promo (${num}).jpg`
  return {
    src: assetUrl(`images/SC-promotion/Januaray 2026/${filename}`),
    title: `Promotion ${num}`,
  }
})

export default function Home() {
  const location = useLocation()
  const [slideIndex, setSlideIndex] = useState(0)
  const [promoModal, setPromoModal] = useState({ open: false, image: null })
  const [branchQuery, setBranchQuery] = useState('')
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id)
  const [contactStatus, setContactStatus] = useState('')
  const [contactStatusOk, setContactStatusOk] = useState(false)
  const [contactForm, setContactForm] = useState({
    name: '',
    email: '',
    message: '',
  })

  useEffect(() => {
    document.title = 'SC Group 1989 Official Website'
  }, [])

  useEffect(() => {
    if (!location.hash) return
    const el = document.querySelector(location.hash)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }, [location.hash])

  useEffect(() => {
    const id = setInterval(() => {
      setSlideIndex((prev) => (prev + 1) % heroSlides.length)
    }, 5000)
    return () => clearInterval(id)
  }, [])

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase()
    if (!query) return branches
    return branches.filter((branch) => {
      const text = `${branch.name} ${branch.title} ${branch.hours} ${branch.phone}`.toLowerCase()
      return text.includes(query)
    })
  }, [branchQuery])

  useEffect(() => {
    if (!filteredBranches.length) return
    const hasActive = filteredBranches.some((branch) => branch.id === activeBranchId)
    if (!hasActive) {
      setActiveBranchId(filteredBranches[0].id)
    }
  }, [filteredBranches, activeBranchId])

  const activeBranch = branches.find((branch) => branch.id === activeBranchId) || branches[0]

  const handleContactSubmit = async (event) => {
    event.preventDefault()
    setContactStatus('')
    setContactStatusOk(false)

    if (!contactForm.name || !contactForm.email || !contactForm.message) {
      setContactStatus('All fields are required.')
      return
    }

    try {
      setContactStatus('Sending...')
      const res = await apiFetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contactForm),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Something went wrong!')

      setContactStatus('Message sent successfully!')
      setContactStatusOk(true)
      setContactForm({ name: '', email: '', message: '' })
    } catch (error) {
      setContactStatus(`Error: ${error.message}`)
      setContactStatusOk(false)
    }
  }

  return (
    <div id="top">
      <section id="home">
        <div className="row">
          <div className="home-slider">
            {heroSlides.map((slide, index) => {
              const isActive = index === slideIndex
              const item = (
                <div className={`${slide.className}${isActive ? ' is-active' : ''}`}>
                  <div className="caption">
                    <div className="container" />
                  </div>
                  {slide.linkClass === 'slide-overlay-link' ? (
                    <a
                      href={slide.link}
                      className={slide.linkClass}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={slide.label}
                    />
                  ) : null}
                </div>
              )

              if (slide.linkClass === 'slide-link') {
                return (
                  <div key={slide.id} style={{ display: isActive ? 'block' : 'none' }}>
                    <a
                      href={slide.link}
                      className={slide.linkClass}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={slide.label}
                    >
                      {item}
                    </a>
                  </div>
                )
              }

              return (
                <div key={slide.id} style={{ display: isActive ? 'block' : 'none' }}>
                  {item}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <section id="feature">
        <div className="container">
          <div className="row">
            <div className="col-md-4 col-sm-4">
              <div className="feature-thumb">
                <span>01</span>
                <h3>ร้านยาคุณภาพ ดูแลโดยเภสัชกร</h3>
                <p>
                  ศิริชัยเภสัชให้บริการโดย เภสัชกรประจำร้านทุกสาขา ทุกวัน คอยดูแล
                  ให้คำแนะนำการใช้ยาอย่างถูกต้อง เพื่อความปลอดภัยและความมั่นใจของลูกค้าและครอบครัว
                </p>
              </div>
            </div>
            <div className="col-md-4 col-sm-4">
              <div className="feature-thumb">
                <span>02</span>
                <h3>แหล่งฝึกประสบการณ์วิชาชีพเภสัชกรรม</h3>
                <p>
                  เราเป็นแหล่งฝึกงานสำหรับ นักศึกษาเภสัชศาสตร์ เปิดโอกาสให้นักศึกษาได้เรียนรู้การทำงานหน้าร้านจริง
                  ควบคู่กับการบริหารร้านยาในมุมมองเชิงธุรกิจอย่างเป็นระบบ
                </p>
              </div>
            </div>
            <div className="col-md-4 col-sm-4">
              <div className="feature-thumb">
                <span>03</span>
                <h3>ศูนย์จำหน่ายยาและผลิตภัณฑ์สุขภาพครบวงจร</h3>
                <p>
                  จำหน่าย ยา เวชภัณฑ์ และเวชสำอางที่ได้มาตรฐานคัดสรรผลิตภัณฑ์ที่ปลอดภัย เหมาะสม เชื่อถือได้
                  ตอบโจทย์ทุกความต้องการด้านสุขภาพในที่เดียว
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="about">
        <div className="container">
          <a
            href="https://www.facebook.com/share/p/1Bh9fyYxCU/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Facebook promotion post"
          >
            <img
              src={assetUrl('images/Promotion ads/2026/January/January-promotion-ad.png')}
              className="promo-img"
              alt="January promotion"
            />
          </a>
        </div>
      </section>

      <section id="team">
        <div className="container">
          <div className="row">
            <div className="col-md-12 col-sm-12">
              <div className="section-title">
                <h2>
                  เภสัชกร <small>พบกับเภสัชกรที่พร้อมให้บริการทุกท่าน</small>
                </h2>
              </div>
            </div>

            <div className="col-md-12">
              <div className="team-carousel">
                {teamMembers.map((member) => (
                  <div className="item" key={member.name}>
                    <div className="team-thumb">
                      <div className="team-image">
                        <img src={member.image} className="img-responsive" alt={member.name} />
                      </div>
                      <div className="team-info">
                        <h2>{member.name}</h2>
                        <span />
                      </div>
                      <ul className="social-icon" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="courses" className="coming-soon-wrap">
        <div className="coming-soon-overlay">
          <div className="coming-soon-text">COMING SOON</div>
        </div>

        <div className="container">
          <div className="row">
            <div className="col-md-12 col-sm-12">
              <div className="section-title">
                <h2>ข่าวสารและกิจกรรม</h2>
              </div>

              <div className="owl-courses">
                {courses.map((course) => (
                  <div className="col-md-4 col-sm-4" key={course.title}>
                    <div className="item">
                      <div className="courses-thumb">
                        <div className="courses-top">
                          <div className="courses-image">
                            <img src={course.image} className="img-responsive" alt={course.title} />
                          </div>
                          <div className="courses-date">
                            <span>
                              <i className="fa fa-calendar" /> {course.date}
                            </span>
                            <span>
                              <i className="fa fa-clock-o" /> {course.duration}
                            </span>
                          </div>
                        </div>

                        <div className="courses-detail">
                          <h3>
                            <a href="#">{course.title}</a>
                          </h3>
                          <p>{course.desc}</p>
                        </div>

                        <div className="courses-info">
                          <div className="courses-author">
                            <img src={course.authorImage} className="img-responsive" alt="" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="testimonial" className="coming-soon-wrap">
        <div className="container">
          <div className="row">
            <div className="col-md-12 col-sm-12">
              <div className="section-title">
                <h2>สินค้าโปรโมชั่นประจำเดือน</h2>
              </div>

              <div id="promoCarousel" className="promo-carousel-grid">
                {promoImages.map((promo) => (
                  <div
                    key={promo.src}
                    className="item promo-item"
                    onClick={() =>
                      setPromoModal({ open: true, image: { src: promo.src, alt: promo.title } })
                    }
                  >
                    <img src={promo.src} className="img-responsive promo-img" alt={promo.title} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="branches">
        <div className="container">
          <div className="row">
            <div className="col-md-12 col-sm-12">
              <div className="section-title">
                <h2>
                  สาขาของเรา <small>Find a branch near you</small>
                </h2>
              </div>
            </div>

            <div className="col-md-5 col-sm-12">
              <div className="branch-panel">
                <input
                  id="branchSearch"
                  className="branch-search form-control"
                  type="text"
                  placeholder="ค้นหาสาขา... (พิมพ์ชื่อ/เวลา/คำว่า เปิด)"
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                />

                <div id="branchList" className="branch-list">
                  {filteredBranches.map((branch) => (
                    <div
                      key={branch.id}
                      className={`branch-card${branch.id === activeBranchId ? ' is-active' : ''}`}
                      onClick={(event) => {
                        if (event.target.closest('a')) return
                        setActiveBranchId(branch.id)
                      }}
                    >
                      <h3>{branch.title}</h3>
                      <p>
                        {branch.hours}
                        {branch.isHQ ? (
                          <>
                            {' '}
                          <small style={{ color: 'red', fontWeight: 'bold' }}>**สำนักงานใหญ่</small>
                          </>
                        ) : null}
                      </p>
                      <p>โทร: {branch.phone}</p>
                      <a
                        className="btn btn-default"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={`https://www.google.com/maps/dir/?api=1&destination=${branch.lat},${branch.lng}`}
                      >
                        เส้นทาง
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="col-md-7 col-sm-12">
              <div className="map-panel">
                <iframe
                  id="branchMap"
                  width="100%"
                  height="420"
                  style={{ border: 0 }}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://www.google.com/maps?q=${activeBranch?.lat},${activeBranch?.lng}&z=16&output=embed`}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="contact">
        <div className="container">
          <div className="row">
            <div className="col-md-6 col-sm-12">
              <form id="contact-form" role="form" onSubmit={handleContactSubmit}>
                <p
                  id="contact-status"
                  style={{
                    marginTop: 10,
                    color: contactStatusOk ? 'green' : 'crimson',
                  }}
                >
                  {contactStatus}
                </p>
                <div className="section-title">
                  <h2>
                    ติดต่อเรา{' '}
                    <small>ฝากข้อมูลอีเมล์และข้อความที่ต้องการติดต่อไว้ที่นี่</small>
                  </h2>
                </div>

                <div className="col-md-12 col-sm-12">
                  <input
                    type="text"
                    className="form-control"
                    placeholder="ชื่อ-นามสกุล"
                    name="name"
                    value={contactForm.name}
                    onChange={(event) =>
                      setContactForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    required
                  />

                  <input
                    type="email"
                    className="form-control"
                    placeholder="อีเมล์"
                    name="email"
                    value={contactForm.email}
                    onChange={(event) =>
                      setContactForm((prev) => ({ ...prev, email: event.target.value }))
                    }
                    required
                  />

                  <textarea
                    className="form-control"
                    rows="6"
                    placeholder="ข้อความ"
                    name="message"
                    value={contactForm.message}
                    onChange={(event) =>
                      setContactForm((prev) => ({ ...prev, message: event.target.value }))
                    }
                    required
                  />
                </div>

                <div className="col-md-4 col-sm-12">
                  <input
                    type="submit"
                    className="form-control"
                    name="send message"
                    value="ส่งข้อความ"
                  />
                </div>
              </form>
            </div>

            <div className="col-md-6 col-sm-12">
              <div className="contact-image">
                <img
                  src="https://qr-official.line.me/gs/M_551jecmm_BW.png?oat_content=qr"
                  alt="LINE Official Account QR"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <PromoModal
        open={promoModal.open}
        image={promoModal.image}
        onClose={() => setPromoModal({ open: false, image: null })}
      />
    </div>
  )
}
