import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDatabaseContainer } from './guard.mjs';
const good = { Config: { Labels: { 'com.docker.compose.project': 'piano-isolated-abcdef123456', 'com.docker.compose.service': 'core-db' } }, HostConfig: { NetworkMode: 'piano-isolated-abcdef123456_private', Tmpfs: { '/var/lib/postgresql/data': 'rw' }, PortBindings: {} }, Mounts: [], NetworkSettings: { Networks: { 'piano-isolated-abcdef123456_private': {} }, Ports: { '5432/tcp': null } } };
test('only a fresh private in-memory database container is accepted', () => {
  assert.doesNotThrow(() => validateDatabaseContainer(good, 'piano-isolated-abcdef123456', 'core-db'));
  for (const change of [x => x.Config.Labels['com.docker.compose.project']='piano-ai-audit', x => x.HostConfig.NetworkMode='host', x => x.NetworkSettings.Networks.other={}, x => x.HostConfig.Tmpfs={}, x => x.Mounts.push({Type:'volume'}), x => x.NetworkSettings.Ports['5432/tcp']=[{HostPort:'5443'}], x => x.HostConfig.PortBindings={'5432/tcp':[{}]}]) {
    const bad=structuredClone(good); change(bad);
    assert.throws(() => validateDatabaseContainer(bad, 'piano-isolated-abcdef123456', 'core-db'));
  }
});
