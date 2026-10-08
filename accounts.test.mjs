import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { AccountError, AccountStore, accountConfiguration, validateUsername, normalizedLifeRequest, customLifeReceipt, verifyLifeReceipt, verifyAppleIdentity, discoveryTitle, withDiscoveryTitle } from './accounts.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const secret = 'test-receipt-secret-only';
const prompt = 'I want to be a flying crocodile on Mars';
const receipt = (installation = 'device1', changes = {}) => customLifeReceipt({ prompt, installation,
  generation: randomUUID(), content: JSON.stringify({ story: 'You soar over the red dunes of Mars.' }), signingSecret: secret, ...changes });

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  const client = { query: (sql, values) => values ? db.query(sql, values) : sql.includes('CREATE TABLE') ? db.exec(sql) : db.query(sql), release() {} };
  const store = new AccountStore({ ...client, connect: async () => client });
  await store.migrate();
  return store;
}
async function login(store, installation = 'device1', subject = 'verified-subject', provider = 'apple') {
  const verifier = randomBytes(32).toString('base64url');
  const start = await store.startFlow(installation, provider, hash(verifier));
  const flow = await store.flow(start.id, installation, verifier);
  const session = await store.finishFlow(flow, { subject, revokeToken: 'encrypted-provider-token' });
  return { ...session, flow, verifier };
}

test('names reject profanity, common evasions, invalid syntax and impersonation', () => {
  for (const name of ['fuckyou', 'f_u_c_k', 'sh1thead', 'Admin', 'AgeUp_1', 'a', 'Bob Smith', '<script>', '123Bob']) {
    assert.throws(() => validateUsername(name), undefined, name);
  }
  for (const name of ['Bryce_18', 'Alice', 'Scunthorpe', 'NightExplorer']) assert.equal(validateUsername(name).name, name);
  assert.equal(validateUsername(' Alice ').key, 'alice');
});

test('matching ignores casing and request preambles without merging different settings', () => {
  assert.equal(normalizedLifeRequest(prompt), normalizedLifeRequest('Make me a FLYING crocodile on Mars!'));
  assert.notEqual(normalizedLifeRequest(prompt), normalizedLifeRequest('I want to be a flying crocodile on Earth'));
  assert.throws(() => normalizedLifeRequest('...'));
  assert.throws(() => normalizedLifeRequest('a'.repeat(8001)));
});

test('creation proof is signed, bounded, expiring and installation-bound', () => {
  const proof = receipt();
  assert.equal(verifyLifeReceipt(proof, 'device1', secret).installation, 'device1');
  for (const [value, device, key] of [[proof, 'other', secret], [proof + 'tampered', 'device1', secret], [proof, 'device1', 'wrong'], ['', 'device1', secret]]) {
    assert.throws(() => verifyLifeReceipt(value, device, key));
  }
  assert.throws(() => verifyLifeReceipt(receipt('device1', { now: 0 }), 'device1', secret));
  assert.equal(receipt('device1', { content: '' }), null);
  const labeled = receipt('device1', { content: '```json\n{"public_title":"Flying crocodile on Mars","story":"A complete opening scene."}\n```' });
  assert.equal(verifyLifeReceipt(labeled,'device1',secret).title,'Flying crocodile on Mars');
});

test('disabled and incomplete provider configuration fails closed', () => {
  assert.equal(accountConfiguration({}).available, false);
  const config = accountConfiguration({ ACCOUNTS_ENABLED: 'true', DATABASE_URL: 'postgres://test' });
  assert.equal(config.available, true);
  assert.equal(config.apple_enabled, false); assert.equal(config.google_enabled, false);
  const shared = { AGEUP_SHARED_STORE_ENABLED: 'true', JACKPOT_WORKER_ORIGIN: 'https://shared.example', JACKPOT_BRIDGE_SECRET: 'test-shared-secret-'.repeat(3) };
  assert.equal(accountConfiguration(shared).available, true);
  assert.equal(accountConfiguration(shared).apple_enabled, false);
  assert.equal(accountConfiguration(shared).google_enabled, false);
  for (const change of [{ AGEUP_SHARED_STORE_ENABLED: 'false' }, { JACKPOT_BRIDGE_SECRET: '' },
    { JACKPOT_WORKER_ORIGIN: 'http://shared.example' }, { JACKPOT_WORKER_ORIGIN: 'https://user:password@shared.example' }]) {
    assert.equal(accountConfiguration({ ...shared, ...change }).available, false);
  }
});

test('Apple verification rejects wrong audience, issuer, nonce, signature and expiration', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  async function jwt(changes = {}) {
    return new SignJWT({ nonce: 'nonce', ...changes }).setProtectedHeader({ alg: 'RS256' }).setSubject('apple-user')
      .setIssuer(changes.iss || 'https://appleid.apple.com').setAudience(changes.aud || 'com.brycebehncke.ageup')
      .setIssuedAt().setExpirationTime(changes.exp || '5m').sign(privateKey);
  }
  assert.equal((await verifyAppleIdentity(await jwt(), 'nonce', { keys: publicKey })).sub, 'apple-user');
  for (const change of [{ nonce: 'wrong' }, { iss: 'https://fake.example' }, { aud: 'other.app' }, { exp: 1 }]) {
    await assert.rejects(verifyAppleIdentity(await jwt(change), 'nonce', { keys: publicKey }));
  }
  const other = await generateKeyPair('RS256');
  await assert.rejects(verifyAppleIdentity(await jwt(), 'nonce', { keys: other.publicKey }));
});

test('login is bound to installation and verifier; flow cannot be replayed', async t => {
  const store = await fixture(t);
  const verifier = randomBytes(32).toString('base64url');
  const start = await store.startFlow('device1', 'apple', hash(verifier));
  await assert.rejects(store.flow(start.id, 'other', verifier));
  await assert.rejects(store.flow(start.id, 'device1', 'a'.repeat(43)));
  const flow = await store.flow(start.id, 'device1', verifier);
  const session = await store.finishFlow(flow, { subject: 'user', revokeToken: 'encrypted' });
  await assert.rejects(store.finishFlow(flow, { subject: 'user', revokeToken: 'encrypted' }), { code: 'sign_in_used' });
  await assert.rejects(store.profile(session.session_token, 'other'));
  assert.equal((await store.profile(session.session_token, 'device1')).id, session.profile.id);
  await store.signOut(session.session_token, 'device1');
  await assert.rejects(store.profile(session.session_token, 'device1'));
});

test('completed lives count once across retries, credits follow rename and guest sign-in', async t => {
  const store = await fixture(t);
  const input = { receipt: receipt(), lifeId: randomUUID(), installation: 'device1', signingSecret: secret };
  assert.equal((await store.recordLife(input)).play_count, 1);
  assert.equal((await store.recordLife(input)).play_count, 1);
  assert.equal((await store.recordLife({ ...input, receipt: receipt() })).play_count, 1);
  const session = await login(store);
  await store.rename(session.session_token, 'device1', 'MarsExplorer');
  let stats = await store.recordLife(input);
  assert.equal(stats.first_username, 'MarsExplorer');
  await store.rename(session.session_token, 'device1', 'NewName');
  stats = await store.recordLife({ receipt: receipt('device2'), lifeId: randomUUID(), installation: 'device2', signingSecret: secret });
  assert.equal(stats.play_count, 2); assert.equal(stats.first_username, 'NewName');
  await assert.rejects(store.recordLife({ ...input, receipt: receipt('device1', { prompt: 'a rock' }) }), { code: 'life_receipt_used' });
});

test('username uniqueness is case insensitive; providers do not merge and deletion anonymizes', async t => {
  const store = await fixture(t);
  const first = await login(store);
  const second = await login(store, 'device2', 'verified-subject', 'google');
  assert.notEqual(first.profile.id, second.profile.id);
  await store.rename(first.session_token, 'device1', 'Explorer');
  await assert.rejects(store.rename(second.session_token, 'device2', 'EXPLORER'), { code: 'username_taken' });
  const stats = await store.recordLife({ receipt: receipt(), lifeId: randomUUID(), installation: 'device1', token: first.session_token, signingSecret: secret });
  const revoked = [];
  await store.deleteAccount(first.session_token, 'device1', async (...args) => revoked.push(args));
  assert.equal(revoked.length, 1);
  assert.equal((await store.lifeStats(stats.scenario_id)).first_username, 'Deleted player');
  assert.equal((await store.lifeStats(stats.scenario_id)).play_count, 1);
  await assert.rejects(store.profile(first.session_token, 'device1'));
});

test('deletion requires fresh authentication and keeps data if provider revocation fails', async t => {
  const store = await fixture(t); const session = await login(store);
  await assert.rejects(store.deleteAccount(session.session_token, 'device1', async () => { throw Error('offline'); }));
  assert.equal((await store.profile(session.session_token, 'device1')).id, session.profile.id);
  await store.pool.query("UPDATE ageup_account_sessions SET authenticated_at=now()-interval '11 minutes'");
  await assert.rejects(store.deleteAccount(session.session_token, 'device1', async () => {}), { code: 'reauthentication_required' });
});

test('expired sign-in still counts a completed life, then reauthentication claims it', async t => {
  const store = await fixture(t); const first = await login(store);
  await store.rename(first.session_token, 'device1', 'Explorer');
  await store.pool.query("UPDATE ageup_account_sessions SET expires_at=now()-interval '1 minute'");
  const stats = await store.recordLife({ receipt: receipt(), lifeId: randomUUID(), installation: 'device1', token: first.session_token, signingSecret: secret });
  assert.equal(stats.play_count, 1); assert.equal(stats.first_username, 'Anonymous player');
  await login(store);
  assert.equal((await store.lifeStats(stats.scenario_id)).first_username, 'Explorer');
});

test('public titles use the existing dossier request without modifying ordinary story requests', () => {
  const plain = { messages: [{ role:'user',content:'continue' }] };
  assert.equal(withDiscoveryTitle(plain),plain);
  const original = { ...plain, _ageup_custom_life:prompt,
    response_format:{ type:'json_schema',json_schema:{ name:'birth',strict:true,
      schema:{ type:'object',additionalProperties:false,properties:{ story:{type:'string'} },required:['story'] } } } };
  const augmented = withDiscoveryTitle(original);
  assert.match(augmented.messages[0].content,/public_title/);
  assert.equal(original.messages.length,1);
  assert.deepEqual(original.response_format.json_schema.schema.required,['story']);
  assert.deepEqual(augmented.response_format.json_schema.schema.required,['story','public_title']);
  assert.equal(augmented.response_format.json_schema.schema.additionalProperties,false);
  assert.equal(discoveryTitle('  Flying crocodile\n on Mars '),'Flying crocodile on Mars');
  for (const value of ['', 'x'.repeat(121), 'Contact john@example.com', 'Visit https://example.com', 'Call 123-456-7890', 'fuck you']) {
    assert.equal(discoveryTitle(value),null,value);
  }
});

test('discoveries contain public labels, verified counts, dates and current first-player names only', async t => {
  const store = await fixture(t);
  assert.deepEqual(await store.discoveries(), { discoveries:[],next_cursor:null });
  const first = await login(store);
  await store.rename(first.session_token,'device1','MarsExplorer');
  const proof = receipt('device1', { content:JSON.stringify({ public_title:'Flying crocodile on Mars',story:'You spread your wings above the red dunes.' }) });
  const input = { receipt:proof,lifeId:randomUUID(),installation:'device1',token:first.session_token,signingSecret:secret };
  await store.recordLife(input); await store.recordLife(input);
  await store.recordLife({ ...input,receipt:receipt('device2'),lifeId:randomUUID(),installation:'device2',token:undefined });
  let page = await store.discoveries();
  assert.equal(page.discoveries.length,1);
  assert.equal(page.discoveries[0].title,'Flying crocodile on Mars');
  assert.equal(page.discoveries[0].play_count,2);
  assert.equal(page.discoveries[0].first_username,'MarsExplorer');
  const date = page.discoveries[0].first_played_at;
  assert.ok(Number.isFinite(new Date(date).getTime()));
  assert.deepEqual(Object.keys(page.discoveries[0]).sort(),['scenario_id','title','play_count','first_username','first_played_at'].sort());
  assert.ok(!JSON.stringify(page).includes(prompt));
  await store.rename(first.session_token,'device1','NewExplorer');
  assert.equal((await store.discoveries()).discoveries[0].first_username,'NewExplorer');
  await store.deleteAccount(first.session_token,'device1',async () => {});
  page = await store.discoveries();
  assert.equal(page.discoveries[0].first_username,'Deleted player');
  assert.equal(new Date(page.discoveries[0].first_played_at).getTime(),new Date(date).getTime());
  assert.equal(page.discoveries[0].play_count,2);
});

test('discovery pagination visits every life once, including tied and submillisecond discovery dates', async t => {
  const store = await fixture(t);
  const ids = [];
  for (let i=0;i<5;i++) {
    const stats = await store.recordLife({ receipt:receipt('device1',{ prompt:`Life ${i}`,
      content:JSON.stringify({ public_title:`Life ${i}`,story:'A complete opening with enough descriptive text.' }) }),
      lifeId:randomUUID(),installation:'device1',signingSecret:secret });
    ids.push(stats.scenario_id);
    await store.pool.query('UPDATE ageup_custom_scenarios SET first_played_at=$1 WHERE scenario_id=$2',
      [i < 3 ? '2026-10-01T12:00:00.123456Z' : '2026-10-01T12:00:00.123123Z',stats.scenario_id]);
  }
  let cursor, found = [];
  do {
    const page = await store.discoveries({ cursor,limit:2 });
    assert.ok(page.discoveries.length <= 2);
    found.push(...page.discoveries.map(x=>x.scenario_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(found,[...ids.slice(0,3).sort().reverse(),...ids.slice(3).sort().reverse()]);
  assert.equal(new Set(found).size,5);
  for (const options of [{limit:0},{limit:51},{limit:1.5},{cursor:'bogus'},{cursor:'x'.repeat(513)},
    {cursor:Buffer.from(JSON.stringify({date:'not-a-date',id:ids[0]})).toString('base64url')}]) {
    await assert.rejects(store.discoveries(options),AccountError);
  }
});

test('older signed receipts remain valid without exposing a private prompt as their title', async t => {
  const store = await fixture(t);
  await store.recordLife({receipt:receipt(),lifeId:randomUUID(),installation:'device1',signingSecret:secret});
  assert.equal((await store.discoveries()).discoveries[0].title,'Custom life');
  await store.migrate();
  assert.equal((await store.discoveries()).discoveries[0].play_count,1);
});

test('an uncounted placeholder cannot claim discovery credit before the first completed play', async t => {
  const store = await fixture(t);
  const placeholderOwner = await login(store,'earlier-device','earlier-subject');
  const firstPlayer = await login(store);
  await store.rename(firstPlayer.session_token,'device1','RealExplorer');
  const proof = receipt();
  const scenario = verifyLifeReceipt(proof,'device1',secret).scenario;
  await store.pool.query(`INSERT INTO ageup_custom_scenarios(scenario_id,first_account_id,first_played_at)
    VALUES($1,$2,'2000-01-01T00:00:00Z')`,[scenario,placeholderOwner.profile.id]);
  assert.equal((await store.discoveries()).discoveries.length,0);
  await store.recordLife({ receipt:proof,lifeId:randomUUID(),installation:'device1',token:firstPlayer.session_token,signingSecret:secret });
  const life = (await store.discoveries()).discoveries[0];
  assert.equal(life.first_username,'RealExplorer');
  assert.equal(life.play_count,1);
  assert.ok(new Date(life.first_played_at).getTime() > Date.now() - 60000);
});
