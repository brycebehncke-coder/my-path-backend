export const llcAgeUpIdentity = Object.freeze({
  teamIdentifier: '4S5597VQ7U',
  bundleIdentifier: 'com.behnckemobilegames.ios.ageup',
});

export function ageUpAppIdentities(env = process.env) {
  return [{
    teamIdentifier: env.APP_ATTEST_TEAM_ID?.trim() || 'A8S98U9VW6',
    bundleIdentifier: env.APP_ATTEST_BUNDLE_ID?.trim() || 'com.brycebehncke.ageup',
  }, llcAgeUpIdentity];
}

export function verifySupportedAgeUpProof(verifier, proof, env = process.env) {
  let failure;
  for (const identity of ageUpAppIdentities(env)) {
    try { return verifier({ ...proof, ...identity }); }
    catch (error) { failure = error; }
  }
  throw failure;
}

export function appleSignInClients(env = process.env) {
  const legacy = {
    clientId: env.APPLE_SIGN_IN_CLIENT_ID || 'com.brycebehncke.ageup',
    teamId: env.APPLE_SIGN_IN_TEAM_ID || 'A8S98U9VW6',
    keyId: env.APPLE_SIGN_IN_KEY_ID,
    privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY,
    legacy: true,
  };
  const clients = [legacy];
  if (env.APPLE_SIGN_IN_LLC_KEY_ID && env.APPLE_SIGN_IN_LLC_PRIVATE_KEY) {
    clients.push({ clientId: llcAgeUpIdentity.bundleIdentifier,
      teamId: llcAgeUpIdentity.teamIdentifier,
      keyId: env.APPLE_SIGN_IN_LLC_KEY_ID,
      privateKey: env.APPLE_SIGN_IN_LLC_PRIVATE_KEY,
      legacy: false });
  }
  return clients;
}
