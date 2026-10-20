import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsdj-test-'));
Object.assign(process.env, {
  PUBLIC_URL: 'https://example.test', SPOTIFY_CLIENT_ID: 'x', SPOTIFY_CLIENT_SECRET: 'y', ADMIN_PASSWORD: 'pw', DATA_DIR: dataDir,
});
const rides = await import('../src/ride.js');

test('phones from a ride the driver ended are banned for good', () => {
  const phone = rides.newDeviceId();
  rides.join(phone);
  assert.equal(rides.riderState(phone).active, true);

  rides.endRide('driver double-skipped');
  assert.deepEqual(rides.riderState(phone), { active: false, banned: true });
  assert.throws(() => rides.join(phone), { status: 403 });

  // The ban survives a restart.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'banned-devices.json'), 'utf8')).length, 1);

  // A new rider's phone can still start the next ride.
  const nextRider = rides.newDeviceId();
  rides.join(nextRider);
  assert.equal(rides.riderState(nextRider).active, true);
  rides.endRide('cleanup', { ban: false });
});

test('timeouts end the ride without banning', () => {
  const phone = rides.newDeviceId();
  rides.join(phone);
  rides.endRide('idle', { ban: false });
  assert.deepEqual(rides.riderState(phone), { active: false, banned: false });
  rides.join(phone); // can rejoin
  rides.endRide('cleanup', { ban: false });
});

test('clearing bans lets a phone back in', () => {
  const phone = rides.newDeviceId();
  rides.join(phone);
  rides.endRide('admin');
  assert.ok(rides.clearBans() >= 1);
  rides.join(phone);
  assert.equal(rides.riderState(phone).active, true);
  rides.endRide('cleanup', { ban: false });
});
