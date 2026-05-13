// Constant-time bearer-token check. Workers' runtime does not expose
// Node's `timingSafeEqual`, so we HMAC both strings with a per-process
// random key and compare the resulting digests byte-by-byte without an
// early exit. HMAC normalises both inputs to fixed-length 32-byte buffers
// and randomises the value an attacker can observe across process boots,
// so neither length-leak nor cross-process timing comparisons help them.

let hmacKeyPromise = null;
const encoder = new TextEncoder();

function getHmacKey() {
  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return hmacKeyPromise;
}

async function timingSafeEqualString(a, b) {
  const key = await getHmacKey();
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function checkAuth(request, env) {
  // Fail closed when the secret is missing or empty so a misconfigured
  // deploy can't accept arbitrary `Bearer ` prefixes.
  const token = env.WWWSHARE_UPLOAD_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  return timingSafeEqualString(auth, expected);
}
