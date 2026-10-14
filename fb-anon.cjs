// fb-anon.cjs: anonymous Firebase auth for Node scripts that read/write the neato-ops RTDB over REST.
// Security lockdown 2026-10: the database denies access without auth. Load this ONCE at the top of a script
// (ESM: `import './fb-anon.cjs';`  CJS: `require('./fb-anon.cjs');`) and every global fetch() aimed at
// neato-ops-default-rtdb gets "auth=<token>" appended. Nothing else changes.
// The anonymous account's refresh token is cached in %USERPROFILE%\.fb-anon-neato-ops.json (outside every
// repo, like .flow-token), so all scripts on this machine share one identity and sign up only once.
// If sign-in fails, the request goes out without auth, i.e. exactly what happened before this file existed.
// Keep identical copies in every repo that has one.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const API_KEY = 'AIzaSyBzQ27nDiSsfrxAnrQqYl2jN_YERJim-w4';       // neato-ops web API key: public by design
const DB_MARK = '//neato-ops-default-rtdb.firebaseio.com/';
const CACHE = process.env.FB_ANON_CACHE || path.join(os.homedir(), '.fb-anon-neato-ops.json');

if (!globalThis.__fbAnon) {
  const nativeFetch = globalThis.fetch;
  let mem = null, inflight = null, failUntil = 0;
  const load = () => { if (mem) return mem; try { mem = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { mem = {}; } return mem; };
  const save = s => { mem = s; try { fs.writeFileSync(CACHE, JSON.stringify(s), 'utf8'); } catch (e) {} };
  async function post(url, body, form) {
    const r = await nativeFetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  const signUp = async () => { const j = await post('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY, JSON.stringify({ returnSecureToken: true }));
    return { idToken: j.idToken, refreshToken: j.refreshToken, uid: j.localId, exp: Date.now() + (+j.expiresIn || 3600) * 1000 }; };
  const refresh = async rt => { const j = await post('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt), true);
    return { idToken: j.id_token, refreshToken: j.refresh_token, uid: j.user_id, exp: Date.now() + (+j.expires_in || 3600) * 1000 }; };
  function token(force) {
    const s = load();
    if (!force && s.idToken && s.exp - 300000 > Date.now()) return Promise.resolve(s.idToken);
    if (inflight) return inflight;
    if (Date.now() < failUntil) return Promise.reject(new Error('sign-in backing off'));
    const p = s.refreshToken ? refresh(s.refreshToken).catch(e => { if (e.status === 400) return signUp(); throw e; }) : signUp();
    inflight = p.then(n => { save(n); return n.idToken; }, e => { failUntil = Date.now() + 60000; throw e; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  const withAuth = (u, t) => u + (u.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(t);
  let warned = false;
  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
    if (!url || !url.includes(DB_MARK)) return nativeFetch(input, init);
    let t;
    try { t = await token(); } catch (e) {
      if (!warned) { warned = true; console.warn('[fb-anon] anonymous sign-in failed; sending without auth:', e.message); }
      return nativeFetch(input, init);
    }
    const r = await nativeFetch(withAuth(url, t), init);
    if (r.status !== 401) return r;
    try { return await nativeFetch(withAuth(url, await token(true)), init); } catch (e) { return r; }
  };
  globalThis.__fbAnon = { token };
}
module.exports = globalThis.__fbAnon;
