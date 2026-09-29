// Global test setup: the Registry SDK must never initialize with retries.
process.env.DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES ??= '0';
process.env.COOLIFY_BASE_URL ??= 'http://coolify.local';
process.env.COOLIFY_API_KEY ??= 'test-key';
