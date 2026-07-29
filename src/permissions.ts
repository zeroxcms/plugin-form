export interface FormAdminAccess {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
}

const FULL_ACCESS: FormAdminAccess = {
  canView: true,
  canEdit: true,
  canDelete: true,
  canExport: true,
};

const NO_ACCESS: FormAdminAccess = {
  canView: false,
  canEdit: false,
  canDelete: false,
  canExport: false,
};

export function formAdminAccessForRequest(request: Request): FormAdminAccess {
  const roles = cmsUserRoles(request);
  const permissions = cmsUserPermissions(request);

  // Direct secret-authenticated calls predate x-cms-user forwarding in tests
  // and local tooling. Treat those as trusted full-access calls.
  if (!roles.length) return { ...FULL_ACCESS };
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const canWrite = permissions.includes('forms:write');
  const canView = canWrite || permissions.includes('forms:view') || roles.includes('moderator');
  if (!canView) return { ...NO_ACCESS };

  return {
    canView: true,
    canEdit: canWrite,
    canDelete: canWrite,
    canExport: canWrite,
  };
}

function cmsUserRoles(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { role?: unknown };
    if (typeof parsed.role !== 'string') return [];
    return [...new Set(parsed.role.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function cmsUserPermissions(request: Request): string[] {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { permissions?: unknown };
    if (Array.isArray(parsed.permissions)) {
      return [...new Set(parsed.permissions
        .filter((permission): permission is string => typeof permission === 'string')
        .map((permission) => permission.trim().toLowerCase())
        .filter(Boolean))];
    }
    if (typeof parsed.permissions === 'string') {
      return [...new Set(parsed.permissions.split(',').map((permission) => permission.trim().toLowerCase()).filter(Boolean))];
    }
    return [];
  } catch {
    return [];
  }
}

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
