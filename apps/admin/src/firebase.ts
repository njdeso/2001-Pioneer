import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, browserSessionPersistence, setPersistence } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

// Firebase web config identifies the project; it is not a secret. Access is controlled by
// Firebase Auth + security rules + server-side role checks in Cloud Functions.
const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const configMissing = !config.apiKey || !config.projectId;

export const app = initializeApp(configMissing ? { apiKey: 'missing', projectId: 'demo-asm' } : config);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || 'us-east4');
export const storage = getStorage(app);

/** The production project. Anything else (dev project, emulator) shows a DEV banner. */
export const PRODUCTION_PROJECT_ID = 'pioneer-285cf';
export const projectId = config.projectId ?? 'unknown';
export const usingEmulators = env.VITE_USE_EMULATORS === 'true';
export const isProduction = projectId === PRODUCTION_PROJECT_ID && !usingEmulators;

// Sessions end when the browser tab/window closes.
void setPersistence(auth, browserSessionPersistence);

if (usingEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}
