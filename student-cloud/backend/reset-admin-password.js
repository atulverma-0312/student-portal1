require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const bcrypt = require('bcryptjs');
const store = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resetAdminPassword() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!EMAIL_RE.test(email) || password.length < 12 || password.length > 200 || /replace|change.?me/i.test(password)) {
    throw new Error('Set a valid ADMIN_EMAIL and a new ADMIN_PASSWORD of 12-200 characters in backend/.env.');
  }
  if (!store.supportsPortal) {
    throw new Error('The selected database does not support portal accounts.');
  }

  await store.initialize();
  const user = await store.collection('users').findOne({ email });
  if (!user || user.role !== 'admin') {
    throw new Error(`No admin account exists for ${email}; the command will not create or promote accounts.`);
  }
  if (user.status !== 'active') {
    throw new Error(`Admin account ${email} is inactive; activate it before resetting its password.`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await store.collection('users').updateOne(
    { _id: user._id },
    { $set: { passwordHash, mustChangePassword: false } }
  );
  if (result.matchedCount !== 1) throw new Error('Admin account changed while resetting the password.');
  console.log(`Admin password reset for ${email}.`);
}

resetAdminPassword()
  .catch((error) => {
    console.error(`Admin password reset failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await store.close();
    } catch (error) {
      console.error(`Database close failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
