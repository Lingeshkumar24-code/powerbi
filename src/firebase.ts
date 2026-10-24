/// <reference types="vite/client" />
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type Auth,
  type User,
} from "firebase/auth";

/**
 * Firebase Authentication is the only identity system. The web config is
 * public by design (it is the same object Firebase tells you to paste into a
 * page); authorization always happens on the server against the ID token.
 */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string | null;
  messagingSenderId?: string | null;
}

let auth: Auth | null = null;
let app: FirebaseApp | null = null;

export function firebaseConfigFromEnv(): FirebaseWebConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    apiKey,
    projectId,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? null,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? null,
  };
}

export function initFirebase(config?: FirebaseWebConfig | null): Auth | null {
  if (auth) return auth;
  const cfg = config ?? firebaseConfigFromEnv();
  if (!cfg?.apiKey || !cfg.projectId) return null;
  app = getApps().length
    ? getApp()
    : initializeApp({
        apiKey: cfg.apiKey,
        authDomain: cfg.authDomain,
        projectId: cfg.projectId,
        ...(cfg.appId ? { appId: cfg.appId } : {}),
        ...(cfg.messagingSenderId ? { messagingSenderId: cfg.messagingSenderId } : {}),
      });
  auth = getAuth(app);
  return auth;
}

export function firebaseAuth(): Auth | null {
  return auth;
}

export async function idToken(forceRefresh = false): Promise<string | null> {
  const user = auth?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export function onUserChanged(callback: (user: User | null) => void): () => void {
  if (!auth) return () => {};
  return onAuthStateChanged(auth, callback);
}

export async function register(
  name: string,
  email: string,
  password: string,
): Promise<User> {
  if (!auth) throw new Error("Firebase is not configured on this server.");
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const display = name.trim() || email.split("@")[0];
  if (display) await updateProfile(credential.user, { displayName: display });
  await sendEmailVerification(credential.user);
  return credential.user;
}

export async function signIn(email: string, password: string): Promise<User> {
  if (!auth) throw new Error("Firebase is not configured on this server.");
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

export async function resendVerification(): Promise<void> {
  if (!auth?.currentUser) throw new Error("Sign in first.");
  await sendEmailVerification(auth.currentUser);
}

export async function resetPassword(email: string): Promise<void> {
  if (!auth) throw new Error("Firebase is not configured on this server.");
  await sendPasswordResetEmail(auth, email.trim());
}

export async function reloadUser(): Promise<User | null> {
  const user = auth?.currentUser;
  if (!user) return null;
  await user.reload();
  if (user.emailVerified) await user.getIdToken(true);
  return auth?.currentUser ?? null;
}

export async function logout(): Promise<void> {
  if (auth) await signOut(auth);
}

export function friendlyFirebaseError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/invalid-login-credentials": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/email-already-in-use": "That email already has an account. Sign in or reset the password.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed": "Cannot reach Firebase. Check the connection and try again.",
    "auth/operation-not-allowed": "Email/password sign-in is disabled in the Firebase console.",
    "auth/unauthorized-domain": "This domain is not authorized in Firebase Authentication settings.",
  };
  return map[code] ?? (err as Error)?.message ?? "Authentication failed.";
}
