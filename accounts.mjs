import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import pg from 'pg';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { OAuth2Client } from 'google-auth-library';
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import { D1AccountStore, sharedStoreConfiguration } from './accounts-d1.mjs';

export class AccountError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

export function validateUsername(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(name)) {
    throw new AccountError('username_format', 'Use 3-20 letters, numbers, or underscores, starting with a letter.');
  }
  const lower = name.toLowerCase();
  if (matcher.hasMatch(name) || matcher.hasMatch(name.replaceAll('_', ''))
      || /^(admin|administrator|moderator|support|system|behncke|ageup|anonymous|deleted)(?:_|\d|$)/i.test(name)) {
    throw new AccountError('username_not_allowed', 'Choose a different username. Vulgar, hateful, and impersonating names are not allowed.');
  }
  return { name, key: lower };
}

export function normalizedLifeRequest(raw) {
  const value = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!value || value.length > 8000) throw new AccountError('invalid_life_request', 'Enter a custom-life request of up to 8,000 characters.');
  // Ignore harmless capitalization, whitespace and request preambles. Do not let
  // fuzzy matching collapse distinct dates, identities, places or instructions.
  const normalized = value.toLowerCase().replace(/\s+/gu, ' ')
    .replace(/^(?:i (?:want|would like) to be|make me|let me be|i want to live as)\s+(?:(?:a|an)\s+)?/u, '')
    .replace(/[.!]+$/u, '').trim();
  if (!normalized) throw new AccountError('invalid_life_request', 'Enter a custom-life request.');
  return normalized;
}

export function discoveryTitle(raw) {
  if (typeof raw !== 'string') return null;
  const title = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
  if (!title || [...title].length > 120 || matcher.hasMatch(title)
      || /https?:|www\.|@|\d[\d ()+.-]{7,}\d/iu.test(title)) return null;
  return title;
}

// Add a tiny public label to the existing dossier, never publish the private request.
export function withDiscoveryTitle(body) {
  if (!body._ageup_custom_life || !Array.isArray(body.messages)) return body;
  const instruction = 'Also include public_title: a short life-concept title (2-10 words, at most 120 characters). It is public: omit private personal details, contact details, usernames and instructions. Do not copy the full request.';
  const messages = body.messages.map(message => ({ ...message }));
  const system = messages.findIndex(message => message.role === 'system' && typeof message.content === 'string');
  if (system >= 0) messages[system].content += '\n' + instruction;
  else messages.unshift({ role: 'system', content: instruction });
  const schema = body.response_format?.json_schema?.schema;
  const responseFormat = schema?.type === 'object' && schema.properties
    ? { ...body.response_format, json_schema: { ...body.response_format.json_schema, schema: {
      ...schema, properties: { ...schema.properties, public_title: { type: 'string', maxLength: 120 } },
      required: [...new Set([...(schema.required || []), 'public_title'])],
    } } } : body.response_format;
  return { ...body, messages, ...(responseFormat ? { response_format: responseFormat } : {}) };
}

export function customLifeReceipt({ prompt, installation, generation, content, signingSecret, now = Date.now() }) {
  if (!prompt || !uuid.test(generation || '') || typeof content !== 'string' || content.trim().length < 30) return null;
  let title;
  try {
    const json = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    title = discoveryTitle(JSON.parse(json).public_title);
  } catch { /* Older dossiers have no public title. */ }
  const payload = { v: 1, scenario: digest(normalizedLifeRequest(prompt)), installation, generation, exp: now + 7 * 86400000,
    ...(title ? { title } : {}) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + createHmac('sha256', signingSecret).update('custom-life-v1\0' + encoded).digest('base64url');
}

export function verifyLifeReceipt(raw, installation, signingSecret, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 2000) throw new AccountError('invalid_life_receipt', 'This life has no verified creation receipt.');
  const [encoded, signature, extra] = raw.split('.');
  const expected = createHmac('sha256', signingSecret).update('custom-life-v1\0' + encoded).digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AccountError('invalid_life_receipt', 'This life could not be verified.');
  }
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url')); } catch { /* rejected below */ }
  if (value?.v !== 1 || value.installation !== installation || !uuid.test(value.generation || '')
      || !/^[a-f0-9]{64}$/.test(value.scenario || '') || !Number.isFinite(value.exp) || value.exp < now) {
    throw new AccountError('invalid_life_receipt', 'This life receipt has expired or belongs to another installation.');
  }
  return value;
}

export class AccountStore {
  constructor(pool) { this.pool = pool; }
  async transaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ageup_accounts (
        id uuid PRIMARY KEY, username text, username_key text UNIQUE,
        username_changed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS ageup_account_guests (
        installation_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES ageup_accounts(id)
      );
      CREATE TABLE IF NOT EXISTS ageup_account_identities (
        provider text NOT NULL, subject_hash text NOT NULL, account_id uuid NOT NULL REFERENCES ageup_accounts(id),
        revoke_token text NOT NULL, PRIMARY KEY(provider,subject_hash)
      );
      CREATE TABLE IF NOT EXISTS ageup_account_sessions (
        token_hash text PRIMARY KEY, installation_hash text NOT NULL,
        account_id uuid NOT NULL REFERENCES ageup_accounts(id), provider text NOT NULL,
        authenticated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ageup_account_flows (
        id uuid PRIMARY KEY, installation_hash text NOT NULL, provider text NOT NULL,
        state_hash text UNIQUE NOT NULL, nonce text NOT NULL, code_challenge text NOT NULL,
        expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false,
        verified_subject text, revoke_token text
      );
      CREATE TABLE IF NOT EXISTS ageup_account_rate_limits (
        bucket text PRIMARY KEY, window_start timestamptz NOT NULL, requests integer NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ageup_custom_scenarios (
        scenario_id text PRIMARY KEY, play_count bigint NOT NULL DEFAULT 0,
        first_account_id uuid NOT NULL REFERENCES ageup_accounts(id), first_played_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ageup_custom_plays (
        generation_id uuid PRIMARY KEY, installation_hash text NOT NULL, life_id uuid NOT NULL,
        scenario_id text NOT NULL REFERENCES ageup_custom_scenarios(scenario_id),
        account_id uuid NOT NULL REFERENCES ageup_accounts(id),
        UNIQUE(installation_hash, life_id)
      );
      CREATE INDEX IF NOT EXISTS ageup_account_sessions_expiry ON ageup_account_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS ageup_custom_plays_account ON ageup_custom_plays(account_id);
      ALTER TABLE ageup_custom_scenarios ADD COLUMN IF NOT EXISTS public_title text;
      CREATE INDEX IF NOT EXISTS ageup_custom_scenarios_discovered
        ON ageup_custom_scenarios(first_played_at DESC,scenario_id DESC) WHERE play_count>0;
    `);
  }

  async rateLimit(bucket, limit = 30) {
    const row = (await this.pool.query(`INSERT INTO ageup_account_rate_limits(bucket,window_start,requests)
      VALUES($1,now(),1) ON CONFLICT(bucket) DO UPDATE SET
      requests=CASE WHEN ageup_account_rate_limits.window_start < now()-interval '1 hour' THEN 1 ELSE ageup_account_rate_limits.requests+1 END,
      window_start=CASE WHEN ageup_account_rate_limits.window_start < now()-interval '1 hour' THEN now() ELSE ageup_account_rate_limits.window_start END
      RETURNING requests`, [bucket])).rows[0];
    if (row.requests > limit) throw new AccountError('account_rate_limit', 'Too many attempts. Please try again later.', 429);
  }

  async guest(client, installation) {
    // Serialize guest creation without creating orphan accounts on retries.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['guest:' + installation]);
    const existing = (await client.query('SELECT account_id FROM ageup_account_guests WHERE installation_hash=$1', [installation])).rows[0];
    if (existing) return existing.account_id;
    const id = randomUUID();
    await client.query('INSERT INTO ageup_accounts(id) VALUES($1)', [id]);
    await client.query('INSERT INTO ageup_account_guests(installation_hash,account_id) VALUES($1,$2)', [installation,id]);
    return id;
  }

  async session(token, installation, client = this.pool) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccountError('sign_in_required', 'Sign in to manage your account.', 401);
    const row = (await client.query(`SELECT s.*,a.username FROM ageup_account_sessions s JOIN ageup_accounts a ON a.id=s.account_id
      WHERE token_hash=$1 AND installation_hash=$2 AND expires_at>now() AND a.deleted_at IS NULL`, [digest(token),installation])).rows[0];
    if (!row) throw new AccountError('sign_in_required', 'Your sign-in has expired. Please sign in again.', 401);
    return row;
  }
  async profile(token, installation) {
    const row = await this.session(token, installation);
    return { id: row.account_id, username: row.username, provider: row.provider };
  }
  async rename(token, installation, raw) {
    const value = validateUsername(raw);
    const session = await this.session(token, installation);
    await this.rateLimit('rename:' + session.account_id, 10);
    try {
      await this.pool.query('UPDATE ageup_accounts SET username=$1,username_key=$2,username_changed_at=now() WHERE id=$3 AND deleted_at IS NULL', [value.name,value.key,session.account_id]);
    } catch (error) {
      if (error.code === '23505') throw new AccountError('username_taken', 'That username is already taken.');
      throw error;
    }
    return this.profile(token, installation);
  }
  async signOut(token, installation) {
    await this.pool.query('DELETE FROM ageup_account_sessions WHERE token_hash=$1 AND installation_hash=$2', [digest(token || ''),installation]);
  }

  async startFlow(installation, provider, challenge) {
    if (!['apple','google'].includes(provider) || !/^[A-Za-z0-9_-]{43}$/.test(challenge || '')) {
      throw new AccountError('invalid_sign_in', 'The sign-in request is invalid.');
    }
    await this.rateLimit('login:' + installation, 20);
    await this.pool.query("DELETE FROM ageup_account_flows WHERE expires_at<now()-interval '1 day'");
    await this.pool.query("DELETE FROM ageup_account_sessions WHERE expires_at<now()-interval '1 day'");
    const id = randomUUID(), state = secret(), nonce = secret();
    await this.pool.query(`INSERT INTO ageup_account_flows(id,installation_hash,provider,state_hash,nonce,code_challenge,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, [id,installation,provider,digest(state),nonce,challenge]);
    return { id, state, nonce };
  }
  async flow(id, installation, verifier) {
    if (!uuid.test(id || '') || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier || '')) throw new AccountError('invalid_sign_in', 'Restart sign-in.');
    const row = (await this.pool.query('SELECT * FROM ageup_account_flows WHERE id=$1 AND installation_hash=$2 AND expires_at>now() AND consumed=false', [id,installation])).rows[0];
    if (!row || row.code_challenge !== createHash('sha256').update(verifier).digest('base64url')) {
      throw new AccountError('invalid_sign_in', 'This sign-in has expired or belongs to another device.', 403);
    }
    return row;
  }
  async googleCallbackFlow(state) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) throw new AccountError('invalid_sign_in', 'Invalid sign-in callback.');
    return (await this.pool.query("SELECT * FROM ageup_account_flows WHERE state_hash=$1 AND provider='google' AND consumed=false AND expires_at>now()", [digest(state)])).rows[0];
  }
  async completeGoogleFlow(id, subject, revokeToken) {
    const changed = await this.pool.query(`UPDATE ageup_account_flows SET verified_subject=$1,revoke_token=$2
      WHERE id=$3 AND consumed=false AND verified_subject IS NULL AND expires_at>now() RETURNING id`, [subject,revokeToken,id]);
    if (!changed.rows.length) throw new AccountError('sign_in_used','This sign-in was already used.',409);
  }
  async finishFlow(flow, verified) {
    if (!verified?.subject || !verified.revokeToken) throw new AccountError('identity_unverified', 'The provider could not verify this account.', 401);
    return this.transaction(async client => {
      const claimed = await client.query('UPDATE ageup_account_flows SET consumed=true WHERE id=$1 AND consumed=false AND expires_at>now() RETURNING id', [flow.id]);
      if (!claimed.rows.length) throw new AccountError('sign_in_used', 'This sign-in was already used. Start again.', 409);
      const subjectHash = digest(flow.provider + '\0' + verified.subject);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['identity:' + subjectHash]);
      let row = (await client.query('SELECT account_id FROM ageup_account_identities WHERE provider=$1 AND subject_hash=$2', [flow.provider,subjectHash])).rows[0];
      if (!row) {
        // Each provider identity creates a separate account. Email equality is
        // never accepted as permission to take over another account.
        row = { account_id: randomUUID() };
        await client.query('INSERT INTO ageup_accounts(id) VALUES($1)', [row.account_id]);
      }
      await client.query(`INSERT INTO ageup_account_identities(provider,subject_hash,account_id,revoke_token) VALUES($1,$2,$3,$4)
        ON CONFLICT(provider,subject_hash) DO UPDATE SET revoke_token=EXCLUDED.revoke_token`, [flow.provider,subjectHash,row.account_id,verified.revokeToken]);
      const guest = await this.guest(client, flow.installation_hash);
      await client.query('UPDATE ageup_custom_plays SET account_id=$1 WHERE account_id=$2', [row.account_id,guest]);
      await client.query('UPDATE ageup_custom_scenarios SET first_account_id=$1 WHERE first_account_id=$2', [row.account_id,guest]);
      await client.query('DELETE FROM ageup_account_sessions WHERE installation_hash=$1', [flow.installation_hash]);
      const token = secret();
      await client.query(`INSERT INTO ageup_account_sessions(token_hash,installation_hash,account_id,provider,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 days')`, [digest(token),flow.installation_hash,row.account_id,flow.provider]);
      await client.query('UPDATE ageup_account_flows SET verified_subject=NULL,revoke_token=NULL WHERE id=$1', [flow.id]);
      const account = (await client.query('SELECT username FROM ageup_accounts WHERE id=$1', [row.account_id])).rows[0];
      return { session_token: token, profile: { id: row.account_id, username: account.username, provider: flow.provider } };
    });
  }

  async recordLife({ receipt, lifeId, installation, token, signingSecret }) {
    if (!uuid.test(lifeId || '')) throw new AccountError('invalid_life', 'The life identifier is invalid.');
    const verified = verifyLifeReceipt(receipt, installation, signingSecret);
    return this.transaction(async client => {
      let accountId;
      if (token) {
        try { accountId = (await this.session(token,installation,client)).account_id; }
        catch (error) { if (!(error instanceof AccountError) || error.code !== 'sign_in_required') throw error; }
      }
      // Expired sign-in must not lose a real completed start. Its anonymous
      // attribution can be claimed after the player signs in again.
      if (!accountId) accountId = await this.guest(client,installation);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['life:' + installation + ':' + lifeId]);
      const previous = (await client.query('SELECT scenario_id FROM ageup_custom_plays WHERE generation_id=$1 OR (installation_hash=$2 AND life_id=$3)', [verified.generation,installation,lifeId])).rows[0];
      if (previous && previous.scenario_id !== verified.scenario) throw new AccountError('life_receipt_used', 'This life has already been counted.', 409);
      if (!previous) {
        await client.query(`INSERT INTO ageup_custom_scenarios(scenario_id,first_account_id,public_title) VALUES($1,$2,$3)
          ON CONFLICT(scenario_id) DO UPDATE SET public_title=COALESCE(ageup_custom_scenarios.public_title,EXCLUDED.public_title)`,
          [verified.scenario,accountId,discoveryTitle(verified.title)]);
        const added = await client.query(`INSERT INTO ageup_custom_plays(generation_id,installation_hash,life_id,scenario_id,account_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING generation_id`, [verified.generation,installation,lifeId,verified.scenario,accountId]);
        if (added.rows.length) await client.query(`UPDATE ageup_custom_scenarios SET
          first_account_id=CASE WHEN play_count=0 THEN $2 ELSE first_account_id END,
          first_played_at=CASE WHEN play_count=0 THEN clock_timestamp() ELSE first_played_at END,
          public_title=CASE WHEN play_count=0 THEN COALESCE($3,public_title) ELSE public_title END,
          play_count=play_count+1 WHERE scenario_id=$1`, [verified.scenario,accountId,discoveryTitle(verified.title)]);
      }
      return this.lifeStats(verified.scenario, client);
    });
  }
  async lifeStats(scenario, client = this.pool) {
    const row = (await client.query(`SELECT s.play_count,s.first_played_at,a.username,a.deleted_at FROM ageup_custom_scenarios s
      JOIN ageup_accounts a ON a.id=s.first_account_id WHERE s.scenario_id=$1`, [scenario])).rows[0];
    return { scenario_id: scenario, play_count: Number(row?.play_count || 0),
      first_username: row ? (row.deleted_at ? 'Deleted player' : row.username || 'Anonymous player') : null,
      first_played_at: row?.first_played_at || null };
  }

  async discoveries({ cursor, limit = 30 } = {}) {
    const pageSize = Number(limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new AccountError('invalid_page', 'Request between 1 and 50 discoveries.');
    }
    let after;
    if (cursor != null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        after = JSON.parse(Buffer.from(cursor, 'base64url'));
        if (!/^[a-f0-9]{64}$/.test(after.id) || typeof after.date !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(after.date)
            || !Number.isFinite(Date.parse(after.date))) throw Error();
      } catch { throw new AccountError('invalid_cursor', 'Refresh the discoveries list and try again.'); }
    }
    const rows = (await this.pool.query(`SELECT s.scenario_id,s.public_title,s.play_count,s.first_played_at,a.username,a.deleted_at,
        to_char(s.first_played_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date
      FROM ageup_custom_scenarios s JOIN ageup_accounts a ON a.id=s.first_account_id
      WHERE s.play_count>0 ${after ? 'AND (s.first_played_at,s.scenario_id)<($2::timestamptz,$3)' : ''}
      ORDER BY s.first_played_at DESC,s.scenario_id DESC LIMIT $1`,
      after ? [pageSize + 1,after.date,after.id] : [pageSize + 1])).rows;
    const page = rows.slice(0,pageSize), last = page.at(-1);
    return { discoveries: page.map(row => ({ scenario_id:row.scenario_id,
      title:discoveryTitle(row.public_title) || 'Custom life', play_count:Number(row.play_count),
      first_username:row.deleted_at ? 'Deleted player' : row.username || 'Anonymous player',
      first_played_at:row.first_played_at })),
      next_cursor:rows.length > pageSize ? Buffer.from(JSON.stringify({ date:last.cursor_date,id:last.scenario_id })).toString('base64url') : null };
  }
  async deleteAccount(token, installation, revoke) {
    const session = await this.session(token,installation);
    if (Date.now() - new Date(session.authenticated_at).getTime() > 10 * 60000) {
      throw new AccountError('reauthentication_required', 'Sign in again before deleting your account.', 401);
    }
    const identities = (await this.pool.query('SELECT provider,revoke_token FROM ageup_account_identities WHERE account_id=$1', [session.account_id])).rows;
    for (const identity of identities) await revoke(identity.provider,identity.revoke_token);
    await this.transaction(async client => {
      await client.query('UPDATE ageup_accounts SET username=NULL,username_key=NULL,deleted_at=now() WHERE id=$1', [session.account_id]);
      await client.query('DELETE FROM ageup_account_identities WHERE account_id=$1', [session.account_id]);
      await client.query('DELETE FROM ageup_account_sessions WHERE account_id=$1', [session.account_id]);
      await client.query('DELETE FROM ageup_account_flows WHERE installation_hash=$1', [installation]);
    });
    return { ok: true };
  }
}

export function accountConfiguration(env = process.env) {
  const durable = !!sharedStoreConfiguration(env)
    || (!!(env.ACCOUNTS_DATABASE_URL || env.DATABASE_URL) && env.ACCOUNTS_ENABLED === 'true');
  const encrypted = Buffer.from(env.ACCOUNT_ENCRYPTION_KEY || '', 'base64').length === 32;
  let origin;
  try { const parsed = new URL(env.ACCOUNT_PUBLIC_ORIGIN || ''); if (parsed.protocol === 'https:') origin = parsed.origin; } catch { /* not configured */ }
  return { available: durable, apple_enabled: durable && encrypted && !!env.APPLE_SIGN_IN_KEY_ID && !!env.APPLE_SIGN_IN_PRIVATE_KEY,
    google_enabled: durable && encrypted && !!origin && !!env.GOOGLE_SIGN_IN_CLIENT_ID && !!env.GOOGLE_SIGN_IN_CLIENT_SECRET,
    origin, appleClient: env.APPLE_SIGN_IN_CLIENT_ID || 'com.brycebehncke.ageup' };
}

function protectToken(value, decrypt = false) {
  const key = Buffer.from(process.env.ACCOUNT_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new AccountError('accounts_not_configured', 'Accounts are not configured yet.', 503);
  if (decrypt) {
    const [iv,tag,ciphertext] = value.split('.').map(x => Buffer.from(x,'base64url'));
    const cipher = createDecipheriv('aes-256-gcm',key,iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext),cipher.final()]).toString('utf8');
  }
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv);
  const ciphertext = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),ciphertext].map(x => x.toString('base64url')).join('.');
}
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const googleClient = () => {
  const client = new OAuth2Client(process.env.GOOGLE_SIGN_IN_CLIENT_ID,process.env.GOOGLE_SIGN_IN_CLIENT_SECRET,
    accountConfiguration().origin + '/v1/accounts/google/callback');
  client.transporter.defaults.timeout = 15000;
  return client;
};

async function appleClientSecret() {
  const key = await importPKCS8(process.env.APPLE_SIGN_IN_PRIVATE_KEY.replaceAll('\\n','\n'),'ES256');
  return new SignJWT({}).setProtectedHeader({ alg:'ES256',kid:process.env.APPLE_SIGN_IN_KEY_ID })
    .setIssuer(process.env.APPLE_SIGN_IN_TEAM_ID || 'A8S98U9VW6').setSubject(accountConfiguration().appleClient)
    .setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);
}
export async function verifyAppleIdentity(idToken, nonce, { keys = appleKeys, audience = accountConfiguration().appleClient } = {}) {
  const { payload } = await jwtVerify(idToken, keys, { issuer:'https://appleid.apple.com',audience,algorithms:['RS256'],maxTokenAge:'10m' });
  if (!payload.sub || payload.nonce !== nonce) throw new AccountError('identity_unverified','Apple could not verify this sign-in.',401);
  return payload;
}
async function verifyApple(flow, body) {
  const claims = await verifyAppleIdentity(body.identity_token,flow.nonce);
  const response = await fetch('https://appleid.apple.com/auth/token', { method:'POST',signal:AbortSignal.timeout(15000),
    body:new URLSearchParams({ client_id:accountConfiguration().appleClient,client_secret:await appleClientSecret(),
      code:body.authorization_code || '',grant_type:'authorization_code' }) });
  const tokens = await response.json();
  if (!response.ok || !tokens.refresh_token) throw new AccountError('identity_unverified','Apple sign-in did not complete. Please try again.',401);
  const exchanged = await verifyAppleIdentity(tokens.id_token,flow.nonce);
  if (exchanged.sub !== claims.sub) throw new AccountError('identity_unverified','Apple identity did not match.',401);
  return { subject:claims.sub,revokeToken:protectToken(tokens.refresh_token) };
}
async function revoke(provider, encrypted) {
  const token = protectToken(encrypted,true);
  if (provider === 'google') {
    const response = await fetch('https://oauth2.googleapis.com/revoke', { method:'POST',signal:AbortSignal.timeout(15000),body:new URLSearchParams({token}) });
    if (!response.ok && response.status !== 400) throw new AccountError('revoke_unavailable','Google could not complete account deletion. Please try again.',503);
  } else {
    const response = await fetch('https://appleid.apple.com/auth/revoke', { method:'POST',signal:AbortSignal.timeout(15000),
      body:new URLSearchParams({client_id:accountConfiguration().appleClient,client_secret:await appleClientSecret(),token,token_type_hint:'refresh_token'}) });
    if (!response.ok) throw new AccountError('revoke_unavailable','Apple could not complete account deletion. Please try again.',503);
  }
}

let configured;
export async function configuredAccounts() {
  if (!accountConfiguration().available) return null;
  if (!configured) configured = (async () => {
    const shared = sharedStoreConfiguration();
    if (shared) return new D1AccountStore({ ...shared, validateUsername, verifyLifeReceipt, discoveryTitle, ErrorType: AccountError });
    const pool = new pg.Pool({ connectionString:process.env.ACCOUNTS_DATABASE_URL || process.env.DATABASE_URL,max:5,
      connectionTimeoutMillis:10000,idleTimeoutMillis:30000 });
    const store = new AccountStore(pool);
    try { await store.migrate(); return store; }
    catch (error) { await pool.end(); throw error; }
  })().catch(error => { configured = null; throw error; });
  return configured;
}

export async function handleAccountRequest({ path, body, installation, token, signingSecret }) {
  const config = accountConfiguration();
  if (path === '/v1/accounts/configuration') return { available:config.available,apple_enabled:config.apple_enabled,google_enabled:config.google_enabled };
  const store = await configuredAccounts();
  if (!store) throw new AccountError('accounts_not_configured','Online accounts are not available yet. Your local game is unaffected.',503);
  await store.rateLimit('requests:' + installation,300);
  switch (path) {
  case '/v1/accounts/start': {
    if (!(body.provider === 'apple' ? config.apple_enabled : body.provider === 'google' && config.google_enabled)) {
      throw new AccountError('provider_not_configured','This sign-in provider is not available yet.',503);
    }
    const flow = await store.startFlow(installation,body.provider,body.code_challenge);
    return { flow_id:flow.id,state:flow.state,nonce:flow.nonce,
      authorization_url:body.provider === 'google' ? googleClient().generateAuthUrl({scope:['openid','email'],access_type:'offline',prompt:'consent select_account',state:flow.state,nonce:flow.nonce}) : null };
  }
  case '/v1/accounts/finish': {
    const flow = await store.flow(body.flow_id,installation,body.code_verifier);
    const verified = flow.provider === 'apple' ? await verifyApple(flow,body)
      : { subject:flow.verified_subject,revokeToken:flow.revoke_token };
    return store.finishFlow(flow,verified);
  }
  case '/v1/accounts/me': return store.profile(token,installation);
  case '/v1/accounts/username': return store.rename(token,installation,body.username);
  case '/v1/accounts/sign-out': await store.signOut(token,installation); return { ok:true };
  case '/v1/accounts/delete': return store.deleteAccount(token,installation,revoke);
  case '/v1/custom-lives/register': return store.recordLife({ receipt:body.receipt,lifeId:body.life_id,installation,token,signingSecret });
  case '/v1/custom-lives/discoveries': return store.discoveries({ cursor:body.cursor,limit:body.limit ?? 30 });
  case '/v1/custom-lives/stats': {
    if (body.scenario_id && !/^[a-f0-9]{64}$/.test(body.scenario_id)) throw new AccountError('invalid_life', 'Invalid life.');
    return store.lifeStats(body.scenario_id || digest(normalizedLifeRequest(body.prompt)));
  }
  default: throw new AccountError('not_found','Not found.',404);
  }
}

export async function googleSignInCallback(params) {
  const store = await configuredAccounts();
  if (!store || !accountConfiguration().google_enabled) throw new AccountError('provider_not_configured','Google sign-in is not configured.',503);
  const flow = await store.googleCallbackFlow(params.get('state'));
  if (!flow) throw new AccountError('invalid_sign_in','This sign-in has expired.',403);
  const callback = new URL('com.brycebehncke.ageup.auth://sign-in');
  callback.searchParams.set('flow',flow.id); callback.searchParams.set('state',params.get('state'));
  if (params.has('error')) { callback.searchParams.set('error','cancelled'); return callback.toString(); }
  const code = params.get('code');
  if (!code || code.length > 4096) throw new AccountError('invalid_sign_in','Invalid sign-in response.');
  const client = googleClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_SIGN_IN_CLIENT_ID});
  const claims = ticket.getPayload();
  if (!claims?.sub || claims.nonce !== flow.nonce || claims.email_verified !== true || !(tokens.refresh_token || tokens.access_token)) {
    throw new AccountError('identity_unverified','Google could not verify this account.',401);
  }
  await store.completeGoogleFlow(flow.id, claims.sub, protectToken(tokens.refresh_token || tokens.access_token));
  return callback.toString();
}
