# Monthly Promotion Update Prompt (Vite + React)

Use this template whenever you want to switch the monthly promotion assets.
Only replace the placeholder values (MONTH, YEAR, and PROMO_AD_FILENAME).

---

## Prompt Template (copy/paste)

You are editing `frontend-react/src/routes/Home.jsx`.
Target month: **<MONTH> <YEAR>**.

Please update both promotion sections to the new month:

1) **Promotions carousel**
   - Locate `promoImages` and update the folder path to:
     `images/SC-promotion/<MONTH> <YEAR>/`
   - Keep the `BASE_URL`/`assetUrl` logic intact.
   - If the folder uses a different filename pattern or count,
     update `promoImageCount` and the filename template accordingly.

2) **About section promo ad**
   - Update the image src to:
     `images/Promotion ads/<YEAR>/<MONTH>/<PROMO_AD_FILENAME>`
   - Update alt text to: `"<MONTH> promotion"`
   - Do **not** change the Facebook `href` (I will update it manually).

Constraints:
- Do not change Swiper layout, lazy loading, or modal behavior.
- Keep everything else the same.

Return:
- A short summary of what you changed.

---

## Example (replace placeholders)

MONTH = February
YEAR = 2026
PROMO_AD_FILENAME = February-promotion-ad-2026.png

