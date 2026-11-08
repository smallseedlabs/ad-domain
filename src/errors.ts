export class ConfigError extends Error {
  readonly code = 'config_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RequestValidationError extends Error {
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export class IdentityRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdentityRejectedError';
    this.code = code;
  }
}

export class TokenVerificationError extends IdentityRejectedError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'TokenVerificationError';
  }
}

export class WorkspaceScopeError extends Error {
  readonly code = 'workspace_mismatch';

  constructor(message = 'workspace in the body does not match the caller identity') {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor(message = 'idempotency key was reused with a different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class StaleVersionError extends Error {
  readonly code = 'stale_version';

  constructor(message = 'campaign version does not match the expected version') {
    super(message);
    this.name = 'StaleVersionError';
  }
}

export class OwnershipError extends Error {
  readonly code = 'ownership_mismatch';

  constructor(message = 'campaign does not belong to this workspace, account, or provider mapping') {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class BillingNotReadyError extends Error {
  readonly code = 'billing_not_ready';

  constructor(message: string) {
    super(message);
    this.name = 'BillingNotReadyError';
  }
}

export class ProviderUnconfiguredError extends Error {
  readonly code = 'provider_unconfigured';

  constructor(message = 'provider adapter is not configured; mutation is refused') {
    super(message);
    this.name = 'ProviderUnconfiguredError';
  }
}

export class AmbiguousOutcomeError extends Error {
  readonly code = 'outcome_ambiguous';

  constructor(message = 'provider outcome is ambiguous; this key will not be retried') {
    super(message);
    this.name = 'AmbiguousOutcomeError';
  }
}

export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';

  constructor(message = 'audit publisher is not ready') {
    super(message);
    this.name = 'AuditUnavailableError';
  }
}

export class DomainRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainRefusedError';
    this.code = code;
  }
}
