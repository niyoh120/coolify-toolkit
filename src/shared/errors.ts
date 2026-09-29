// Unified error codes returned by the API; UI maps them to messages.
export const errorCodes = {
  validation: 'validation_error',
  notFound: 'not_found',
  conflict: 'conflict', // config changed vs preview / concurrent edit
  blocked: 'blocked', // resource blocked from the requested action
  policyForbidden: 'policy_forbidden', // e.g. update on ignored resource
  externalChange: 'external_change',
  candidateUnknown: 'candidate_unknown',
  coolifyUnavailable: 'coolify_unavailable',
  registryError: 'registry_error',
  appriseError: 'apprise_error',
  singleInstance: 'single_instance',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export class ApiRequestError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}
