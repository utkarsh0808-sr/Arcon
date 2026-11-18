// Firebase compat SDK is loaded from Google's hosted SDK scripts in public/index.html.
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

export const firebaseConfigReady = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId &&
  firebaseConfig.appId && firebaseConfig.messagingSenderId
);
const firebaseSdk = typeof window !== "undefined" ? window.firebase : null;
export const firebaseApp = firebaseConfigReady && firebaseSdk
  ? (firebaseSdk.apps.length ? firebaseSdk.app() : firebaseSdk.initializeApp(firebaseConfig))
  : null;
export const getAuth = (app) => app.auth();
export const onAuthStateChanged = (auth, callback) => auth.onAuthStateChanged(callback);
export const signInWithEmailAndPassword = (auth, email, password) => auth.signInWithEmailAndPassword(email, password);
export const createUserWithEmailAndPassword = (auth, email, password) => auth.createUserWithEmailAndPassword(email, password);
export const GoogleAuthProvider = firebaseSdk?.auth?.GoogleAuthProvider;
export const signInWithPopup = (auth, provider) => auth.signInWithPopup(new provider());
export const sendEmailVerification = (user) => user.sendEmailVerification();
export const sendPasswordResetEmail = (auth, email) => auth.sendPasswordResetEmail(email);
export const signOut = (auth) => auth.signOut();