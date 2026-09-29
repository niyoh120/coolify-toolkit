// Module-evaluation-order guard: the Registry SDK reads its retry env at load
// time. This file must stay the FIRST import of the server entry so the SDK
// never initializes with internal retries enabled (executor owns scheduling).
process.env.DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES ??= '0';
if (process.env.DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES !== '0') {
  throw new Error('DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES must stay "0" for the toolkit');
}

export {};
