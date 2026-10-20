const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const number = (name, fallback) => (env[name] ? Number(env[name]) : fallback);

export const config = {
  port: number('PORT', 8080),
  publicUrl: required('PUBLIC_URL').replace(/\/+$/, ''),
  spotifyClientId: required('SPOTIFY_CLIENT_ID'),
  spotifyClientSecret: required('SPOTIFY_CLIENT_SECRET'),
  adminPassword: required('ADMIN_PASSWORD'),
  dataDir: env.DATA_DIR ?? './data',

  // Riders
  songLimit: number('SONG_LIMIT', 5),

  // Ending rides
  doubleSkipWindowMs: number('DOUBLE_SKIP_WINDOW_SECONDS', 20) * 1000,
  rideIdleMinutes: number('RIDE_IDLE_MINUTES', 20),
  rideMaxMinutes: number('RIDE_MAX_MINUTES', 180),
};
