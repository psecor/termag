export type OrgAccess =
  | { status: 'ok' }
  | { status: 'sso-required'; ssoUrl: string | null }
  | { status: 'app-policy' }
  | { status: 'rate-limited'; retryAfter: string | null }
  | { status: 'error'; retryAfter: string | null };

export interface OrgLine {
  text: string;
  href?: string;
}

export function githubOrgLine(org: string, access: OrgAccess): OrgLine {
  switch (access.status) {
    case 'ok':
      return { text: org };
    case 'sso-required':
      return access.ssoUrl
        ? { text: `Authorize this token for ${org} SSO`, href: access.ssoUrl }
        : { text: `Authorize this token for ${org} SSO` };
    case 'app-policy':
      return { text: `${org} restricts OAuth apps; ask an org owner to approve GitHub CLI` };
    case 'rate-limited':
      return { text: `GitHub rate-limited requests for ${org}. Try again later.` };
    case 'error':
      return { text: `Could not reach GitHub to check ${org}. Try Re-check.` };
  }
}
