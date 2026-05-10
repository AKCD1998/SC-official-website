# Home Slider Image Edit Mode

## Repo Findings

- Frontend framework: Vite + React in `frontend-react/`, using React Router and Swiper.
- Backend/API: Node/Express in `backend/`, with routes mounted from `backend/server.js`.
- Slider component: `frontend-react/src/routes/Home.jsx` renders the homepage `<div className="home-slider">`.
- Default slider images: `frontend-react/public/images/cover-Facebook-company-page.png`, `frontend-react/public/images/cover-Facebook-HrRx.png`, and `frontend-react/public/images/sirichai-bangnoi.webp`.
- Legacy image copies also exist in `legacy/images/`, but the React app serves from `frontend-react/public/images/`.
- Auth detection: `/api/auth/login` signs a JWT containing the user email. The frontend stores it in `localStorage` key `token` and parses it through `AuthContext`.
- Admin detection: slider upload permission is checked server-side in `backend/routes/slider.js` by verifying the JWT with `JWT_SECRET` and checking the email against comma-separated `SITE_ADMIN_EMAILS`.
- Slider config persistence: custom image URLs are stored in PostgreSQL table `slider_config`, created by `backend/migrations/slider_config_table.sql`.
- Upload storage: `backend/lib/r2Storage.js` uploads to Cloudflare R2 when `R2_*` env vars are configured. Without R2, local development falls back to `backend/uploads/slider`, served at `/uploads/slider`.

## Client vs Server Admin Check

The frontend can use the token only to decide whether to show edit controls. It is not a security boundary because local storage and React state can be changed by a user. Upload authorization must stay server-side, and `/api/slider/upload/:slideId` must reject missing, expired, or non-admin JWTs.

## Recommended Implementation

- Add the existing admin account email to `SITE_ADMIN_EMAILS` in the backend environment.
- Use R2 or another persistent object store for production uploads. Local disk fallback is fine for development, but not reliable on ephemeral hosts.
- Keep the React defaults as fallback images so visitors still see the old slider if config loading, upload, storage, or a custom image URL fails.
- Keep GitHub Pages builds static-compatible for viewing. Image upload/edit mode requires the backend API plus database/storage and cannot work on GitHub Pages alone. For a Pages frontend, set `VITE_API_BASE_URL` to the deployed backend API origin.

## Manual Test Checklist

- Visitor cannot see edit controls on the homepage slider.
- Admin listed in `SITE_ADMIN_EMAILS` can log in and see the slider edit-mode toggle.
- Admin can turn edit mode on and click `Change image` on each slide.
- Invalid file type is rejected in the browser.
- Spoofed or non-image content is rejected by the backend.
- Oversized image is rejected.
- Valid PNG/JPG/JPEG/WebP uploads successfully.
- The changed slide uses the uploaded image immediately after upload.
- The changed slide still uses the uploaded image after refresh.
- Existing slide links, alt text, and loading behavior remain intact.
- Old default image appears if config loading fails or a custom uploaded image URL cannot load.
