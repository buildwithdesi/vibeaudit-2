// Planted class: secrets in code. These values are fake and the app never
// connects anywhere, but the pattern is exactly what shows up in vibe-coded
// repos: credentials typed straight into a config module.
export const database = {
  host: 'db.internal',
  user: 'app',
  password: 'Winter2026Prod!',
  connectionString: 'postgres://app:Winter2026Prod@db.internal:5432/app',
};
