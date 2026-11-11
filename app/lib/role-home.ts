import { UserRole } from "~/db/schema";

// ─── Role home pages ───
// Where a user lands after signing in or switching user, when no explicit
// destination is given. Safe on server and client (the DevUI uses it).

/**
 * The home page for a role, or null when the role has none and the caller's
 * own default applies. Instructors land on "My Courses".
 */
export function homePathForRole(role: UserRole | undefined): string | null {
  return role === UserRole.Instructor ? "/instructor" : null;
}
