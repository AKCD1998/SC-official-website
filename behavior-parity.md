# Behavior Parity Checklist (Golden Tests)

## Auth: login
- React login page: /login
- Submit valid email/password -> token saved in localStorage key `token`
- Invalid credentials -> error message shown and no token saved

## Auth: signup + OTP
- React signup page: /signup
- Start signup -> OTP email sent
- Verify OTP -> account created -> redirected to login

## Auth: forgot + reset
- Login page: click "Forgot password"
- Request OTP -> email received
- Verify OTP -> get reset token
- Reset password -> can log in with new password

## Navbar auth state
- When logged in, navbar shows email and dropdown
- When logged out, navbar shows "Log in / sign up"

## Contact form
- Home page contact form submits to /api/contact
- Success message shown and form resets
- Invalid input shows error message

## Logout
- Click Logout in navbar
- token removed from localStorage
- UI resets to logged-out state

## /auth/me
- GET /api/auth/me without token -> unauthorized
- GET /api/auth/me with token -> returns user payload
