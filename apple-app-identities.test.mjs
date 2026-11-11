import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';
import { generateKeyPair, exportPKCS8, SignJWT, jwtVerify } from 'jose';
import { ageUpAppIdentities, verifySupportedAgeUpProof, appleSignInClients } from './apple-app-identities.mjs';
import { verifyApple, revoke, accountConfiguration } from './accounts.mjs';

test('App Attest accepts only the exact legacy and LLC identity pairs', () => {
  const identities = ageUpAppIdentities({});
  assert.deepEqual(identities.map(i => i.teamIdentifier + '.' + i.bundleIdentifier), [
    'A8S98U9VW6.com.brycebehncke.ageup',
    '4S5597VQ7U.com.behnckemobilegames.ios.ageup',
  ]);
  for (const expected of identities) {
    const proof = { signCount:42, publicKey:'unchanged', payload:Buffer.from('signed-request') };
    const verified = verifySupportedAgeUpProof(input => {
      assert.equal(input.payload, proof.payload);
      assert.equal(input.signCount, 42);
      if (input.teamIdentifier !== expected.teamIdentifier || input.bundleIdentifier !== expected.bundleIdentifier) throw Error('rpId mismatch');
      return { signCount:43 };
    }, proof, {});
    assert.equal(verified.signCount, 43);
  }
  for (const wrong of [
    { teamIdentifier:identities[0].teamIdentifier,bundleIdentifier:identities[1].bundleIdentifier },
    { teamIdentifier:identities[1].teamIdentifier,bundleIdentifier:identities[0].bundleIdentifier },
    { teamIdentifier:'OTHERTEAM1',bundleIdentifier:identities[1].bundleIdentifier },
  ]) {
    assert.throws(() => verifySupportedAgeUpProof(input => {
      if (input.teamIdentifier !== wrong.teamIdentifier || input.bundleIdentifier !== wrong.bundleIdentifier) throw Error('rpId mismatch');
      return {};
    }, {}, {}), /rpId mismatch/);
  }
  assert.throws(() => verifySupportedAgeUpProof(() => { throw Error('invalid signature or counter'); }, {}, {}), /invalid signature or counter/);
});

test('incomplete new sign-in credentials cannot enable an audience', () => {
  assert.equal(appleSignInClients({ APPLE_SIGN_IN_LLC_KEY_ID:'NEW' }).length, 1);
  assert.equal(accountConfiguration({ ACCOUNTS_ENABLED:'true',DATABASE_URL:'postgres://test',
    ACCOUNT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),APPLE_SIGN_IN_LLC_KEY_ID:'NEW' }).apple_enabled, false);
});

test('each Apple audience uses its own signing key, subject namespace and revocation client', async () => {
  const apple = await generateKeyPair('RS256');
  const legacy = await generateKeyPair('ES256', { extractable:true });
  const llc = await generateKeyPair('ES256', { extractable:true });
  const env = { APPLE_SIGN_IN_KEY_ID:'OLDKEY0001',APPLE_SIGN_IN_PRIVATE_KEY:await exportPKCS8(legacy.privateKey),
    APPLE_SIGN_IN_LLC_KEY_ID:'NEWKEY0001',APPLE_SIGN_IN_LLC_PRIVATE_KEY:await exportPKCS8(llc.privateKey),
    ACCOUNT_ENCRYPTION_KEY:randomBytes(32).toString('base64') };
  const clients = appleSignInClients(env);
  async function identity(audience, changes = {}) {
    return new SignJWT({ nonce:'nonce', ...changes }).setProtectedHeader({ alg:'RS256' })
      .setSubject(changes.sub || 'same-subject').setIssuer('https://appleid.apple.com').setAudience(audience)
      .setIssuedAt().setExpirationTime('5m').sign(apple.privateKey);
  }
  for (const client of clients) {
    const token = await identity(client.clientId);
    const key = client.legacy ? legacy.publicKey : llc.publicKey;
    let exchanges = 0;
    const verified = await verifyApple({ nonce:'nonce' }, { identity_token:token,authorization_code:'authorization' }, {
      env,keys:apple.publicKey,fetcher:async (url, options) => {
        exchanges++;
        assert.equal(url, 'https://appleid.apple.com/auth/token');
        assert.equal(options.body.get('client_id'), client.clientId);
        assert.equal(options.body.get('code'), 'authorization');
        const proof = await jwtVerify(options.body.get('client_secret'), key, {
          issuer:client.teamId,audience:'https://appleid.apple.com',subject:client.clientId,algorithms:['ES256'],
        });
        assert.equal(proof.protectedHeader.kid, client.keyId);
        return Response.json({ id_token:token,refresh_token:'refresh-' + client.keyId });
      },
    });
    assert.equal(exchanges, 1);
    assert.equal(verified.subject, client.legacy ? 'same-subject' : 'llc:4S5597VQ7U:same-subject');
    await revoke('apple', verified.revokeToken, { env,fetcher:async (url, options) => {
      assert.equal(url, 'https://appleid.apple.com/auth/revoke');
      assert.equal(options.body.get('client_id'), client.clientId);
      assert.equal(options.body.get('token'), 'refresh-' + client.keyId);
      await jwtVerify(options.body.get('client_secret'), key, { issuer:client.teamId,subject:client.clientId });
      return Response.json({});
    } });
    for (const changed of [{ nonce:'wrong' }, { sub:'swapped-subject' }]) {
      await assert.rejects(verifyApple({ nonce:'nonce' }, { identity_token:token }, { env,keys:apple.publicKey,
        fetcher:async () => Response.json({ id_token:await identity(client.clientId, changed),refresh_token:'test' }) }));
    }
    const otherClient = clients.find(other => other !== client);
    await assert.rejects(verifyApple({ nonce:'nonce' }, { identity_token:token }, { env,keys:apple.publicKey,
      fetcher:async () => Response.json({ id_token:await identity(otherClient.clientId),refresh_token:'test' }) }));
  }
  await assert.rejects(verifyApple({ nonce:'nonce' }, { identity_token:await identity('unrelated.app') }, {
    env,keys:apple.publicKey,fetcher:async () => { throw Error('must not exchange an untrusted audience'); },
  }));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',Buffer.from(env.ACCOUNT_ENCRYPTION_KEY,'base64'),iv);
  const ciphertext = Buffer.concat([cipher.update('legacy-raw-refresh'),cipher.final()]);
  const encrypted = [iv,cipher.getAuthTag(),ciphertext].map(value => value.toString('base64url')).join('.');
  await revoke('apple', encrypted, { env,fetcher:async (url, options) => {
    assert.equal(options.body.get('client_id'), clients[0].clientId);
    assert.equal(options.body.get('token'), 'legacy-raw-refresh');
    return Response.json({});
  } });
});
