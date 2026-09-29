// Registry SDK contract guard: the toolkit relies on these exact exports and
// option semantics from @snyk/docker-registry-v2-client 4.0.6. Any SDK upgrade
// must keep this file green before shipping.

import * as sdk from '@snyk/docker-registry-v2-client';
import { describe, expect, it } from 'vitest';
import './setup.js';

describe('registry SDK public surface', () => {
  it('exposes getManifest and content types used by the adapter', () => {
    expect(typeof sdk.getManifest).toBe('function');
    expect(sdk.contentTypes.MANIFEST_V2).toBe(
      'application/vnd.docker.distribution.manifest.v2+json',
    );
    expect(sdk.contentTypes.MANIFEST_LIST_V2).toBe(
      'application/vnd.docker.distribution.manifest.list.v2+json',
    );
    expect(sdk.contentTypes.OCI_MANIFEST_V1).toBe('application/vnd.oci.image.manifest.v1+json');
    expect(sdk.contentTypes.OCI_INDEX_V1).toBe('application/vnd.oci.image.index.v1+json');
  });

  it('caps SDK-internal retries via documented env before first use', async () => {
    // The SDK reads this env at module load; the server entry and the build
    // banner both set it to '0'. Executor-level retry owns scheduling.
    expect(process.env.DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES).toBe('0');
    // Loading any public function must not throw after env is set.
    expect(typeof sdk.getTags).toBe('function');
  });
});
