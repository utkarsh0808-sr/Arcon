const admin = require("firebase-admin");

let initialized = false;
function getFirebaseAdmin() {
  if (initialized) return admin;
  if (!admin.apps.length) {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (rawServiceAccount) {
      let serviceAccount;
      try { serviceAccount = JSON.parse(rawServiceAccount); }
      catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON."); }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: projectId || serviceAccount.project_id });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault(), ...(projectId ? { projectId } : {}) });
    }
  }
  initialized = true;
  return admin;
}

async function verifyApprovedFirebaseUser(idToken) {
  if (!idToken || typeof idToken !== "string") {
    const error = new Error("Sign in with your approved ArConfig account first."); error.status = 401; throw error;
  }
  let firebaseAdmin;
  try { firebaseAdmin = getFirebaseAdmin(); }
  catch (cause) {
    const error = new Error(`Firebase Admin is not configured on the server: ${cause.message}`);
    error.status = 500; error.cause = cause; throw error;
  }
  let decoded;
  try { decoded = await firebaseAdmin.auth().verifyIdToken(idToken, true); }
  catch (cause) {
    const error = new Error("Your Firebase session is invalid or expired. Please sign in again."); error.status = 401; error.cause = cause; throw error;
  }
  const email = String(decoded.email || "").trim().toLowerCase();
  if (!email || decoded.email_verified !== true) {
    const error = new Error("Verify your email address before accessing ArConfig."); error.status = 403; throw error;
  }
  const approvedEmails = String(process.env.ADMIN_EMAILS || "automations@arctrs.com")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const isAdminClaim = decoded.admin === true || decoded.arconfigAdmin === true;
  if (!isAdminClaim && !approvedEmails.includes(email)) {
    const error = new Error("Access denied. Your account has not been approved by an ArConfig administrator."); error.status = 403; throw error;
  }
  return { uid: decoded.uid, email };
}

module.exports = { verifyApprovedFirebaseUser };