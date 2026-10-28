# Web authentication

The web interface requires a user session before loading chat, the M.E.G.A. voice assistant,
history, settings, or other application pages. Authentication data is stored in
`web-auth.db` under the OpenJarvis configuration directory (normally
`~/.openjarvis`; `OPENJARVIS_HOME` and `XDG_DATA_HOME` can change that path).
SQLite schema creation is idempotent and runs when the API application starts.

## Creating the first administrator

The first successful public registration becomes `admin` if no users exist.
On a new server, register the intended administrator before exposing the
service to a network.

For a preconfigured administrator, set both preferred `MEGA_*` environment
variables before starting the server:

```text
MEGA_ADMIN_NAME=admin-name
MEGA_ADMIN_PASSWORD=replace-with-a-long-password
```

The seed is applied at startup: it creates the account or ensures that the
account has the `admin` role and the configured password. Registrations after
the first user receive the `user` role. Roles are checked by the server, not
trusted from the browser.

The former `JARVIS_ADMIN_NAME` and `JARVIS_ADMIN_PASSWORD` names remain accepted
as fallbacks for existing deployments. If both forms are set, `MEGA_*` wins.

Passwords are stored as salted `scrypt` hashes. Sessions use random opaque
tokens in `HttpOnly` cookies; only a hash of each token is stored in SQLite.
Cookies use `SameSite=Lax` for local HTTP and `Secure`/`SameSite=None` for
HTTPS (and secure loopback Tauri origins). Mutating requests with an `Origin`
header must match an allowed frontend origin. Set `OPENJARVIS_CORS_ORIGINS` to
the comma-separated list of exact frontend origins for a deployment.

## Session and rate-limit settings

| Preferred variable | Legacy fallback | Default | Meaning |
|---|---|---:|---|
| `MEGA_SESSION_TTL_SECONDS` | `JARVIS_SESSION_TTL_SECONDS` | `604800` | Absolute session lifetime (7 days) |
| `MEGA_AUTH_MAX_FAILURES` | `JARVIS_AUTH_MAX_FAILURES` | `5` | Failed attempts before temporary blocking |
| `MEGA_AUTH_RATE_WINDOW_SECONDS` | `JARVIS_AUTH_RATE_WINDOW_SECONDS` | `900` | Rate-limit window and blocking period |

When both the preferred and legacy variable are present, the `MEGA_*` value
takes precedence.

Names must contain at least 3 characters after trimming; passwords must
contain at least 8 characters. Login failures return a generic credential
message. Limits are applied independently to the client IP and normalized
username.

## Protected data and migration

All API routes, including chat streaming, speech, connectors, models, and
WebSockets, require a valid session. Only `/auth/register`, `/auth/login`,
`/auth/logout`, `/auth/me`, and `GET /health` are public API routes. Static
frontend assets remain public so the login screen can load; they do not include
user data. CORS preflights are handled before session checks.

Web chat history was previously stored only in the browser's
`openjarvis-conversations` localStorage entry; there was no server-side web
conversation table to migrate. On the first administrator login in a browser,
that legacy list is imported into the new SQLite `conversations` table and
assigned to that administrator. The legacy local entry is removed only after
the server import and history load succeed. New conversations are stored on
the server with their owner's `user_id`; local cache keys are also scoped by
user ID and removed on logout.

Existing browser storage names (`openjarvis-conversations`,
`openjarvis-jarvis-voice`, and `jarvis:debug`) and the `openjarvis_session`
cookie name are intentionally retained. This avoids data loss and invalidating
existing sessions; no local-storage or cookie migration is needed. The option
to accept the former voice activation word remains off by default.

External channel webhooks and OAuth callbacks are subject to the same session
requirement. This intentionally follows the default-deny policy; deployments
that rely on unauthenticated third-party callbacks need a separately designed
machine-authenticated callback flow.

Password recovery and account deletion are not included yet.
