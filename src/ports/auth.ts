export interface IdentityCredentials {
  authorization?: string;
}

export interface VerifiedCaller {
  issuer: string;
  subject: string;
  jti: string;
  keyId: string;
  expiresAt: Date;
  /** Present only when the gateway token carries a workspaceId claim. */
  workspaceId?: string;
}

export interface ServiceAuth {
  readonly name: string;
  authenticate(credentials: IdentityCredentials): Promise<VerifiedCaller>;
}
