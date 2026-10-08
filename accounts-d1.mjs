import { createHash, createHmac } from 'node:crypto';

const path = '/v1/ageup/store';
export function sharedStoreConfiguration(env = process.env) {
  if (env.AGEUP_SHARED_STORE_ENABLED !== 'true') return null;
  const key = env.JACKPOT_BRIDGE_SECRET;
  try {
    const origin = new URL(env.JACKPOT_WORKER_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || typeof key !== 'string' || key.length < 32) return null;
    return { origin: origin.origin, key };
  } catch { return null; }
}

export class D1AccountStore {
  constructor({ origin, key, validateUsername, verifyLifeReceipt, discoveryTitle, ErrorType, fetcher = fetch }) {
    Object.assign(this, { origin, key, validateUsername, verifyLifeReceipt, discoveryTitle, ErrorType, fetcher });
  }
  async request(operation, args) {
    const body = JSON.stringify({ operation, args });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', this.key).update(JSON.stringify(['ageup-store-v1', timestamp, 'POST', path,
      createHash('sha256').update(body).digest('hex')])).digest('hex');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new this.ErrorType('accounts_unavailable', 'Accounts are temporarily unavailable. Please try again.', 503)); }, 10000);
    });
    try {
      const response = await Promise.race([this.fetcher(this.origin + path, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-ageup-time': timestamp, 'x-ageup-signature': signature }, body }), deadline]);
      const result = await Promise.race([response.json(), deadline]);
      if (!response.ok) throw new this.ErrorType(result.error?.code || 'accounts_unavailable',
        result.error?.message || 'Accounts are temporarily unavailable.', response.status);
      return result;
    } finally { clearTimeout(timer); }
  }
  rateLimit(bucket, limit) { return this.request('rateLimit', { bucket, limit }); }
  profile(token, installation) { return this.request('profile', { token, installation }); }
  rename(token, installation, username) {
    const { name, key } = this.validateUsername(username);
    return this.request('rename', { token, installation, name, key });
  }
  signOut(token, installation) { return this.request('signOut', { token, installation }); }
  startFlow(installation, provider, challenge) { return this.request('startFlow', { installation, provider, challenge }); }
  flow(id, installation, verifier) { return this.request('flow', { id, installation, verifier }); }
  finishFlow(flow, verified) { return this.request('finishFlow', { flow, verified }); }
  googleCallbackFlow(state) { return this.request('googleCallbackFlow', { state }); }
  completeGoogleFlow(id, subject, revokeToken) { return this.request('completeGoogleFlow', { id, subject, revokeToken }); }
  recordLife({ receipt, lifeId, installation, token, signingSecret }) {
    const verified = this.verifyLifeReceipt(receipt, installation, signingSecret);
    return this.request('recordLife', { verified: { ...verified, title: this.discoveryTitle(verified.title) }, lifeId, installation, token });
  }
  lifeStats(scenario) { return this.request('lifeStats', { scenario }); }
  async discoveries(options = {}) {
    const page = await this.request('discoveries', options);
    return { ...page, discoveries: page.discoveries.map(row => ({ ...row, title: this.discoveryTitle(row.title) || 'Custom life' })) };
  }
  async deleteAccount(token, installation, revoke) {
    const info = await this.request('deletionInfo', { token, installation });
    for (const identity of info.identities) await revoke(identity.provider, identity.revoke_token);
    return this.request('deleteAccount', { token, installation, id: info.id });
  }
}
