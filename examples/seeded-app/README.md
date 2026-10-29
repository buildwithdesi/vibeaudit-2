# Seeded demo app

An intentionally vulnerable Express app. It is the "before" state for Vibe Audit 2.0 demos and tests. Never deploy it.

Six vulnerability classes are planted across five files:

| Class | File | What is wrong |
|---|---|---|
| Secrets in code | `server/config.js` | A password and a connection string are typed into the source |
| Database injection | `routes/users.js` | Request parameters are pasted into SQL text |
| Missing authorization | `routes/users.js` | Anyone can read or delete any user |
| Command injection | `routes/network.js` | A query parameter lands inside a shell command |
| File path traversal | `routes/files.js` | A query parameter picks which file the server sends |
| Server-side request forgery | `routes/preview.js` | The server fetches any URL the client supplies |

The credentials are fake. The app never connects to anything.
