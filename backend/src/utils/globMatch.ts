/**
 * Minimal glob matcher supporting:
 *   - `*`  — matches any sequence of characters within a single dot-separated segment
 *   - `**` — matches any number of dot-separated segments (including zero)
 *
 * Valid pattern characters: alphanumeric, dot (.), underscore (_), hyphen (-), asterisk (*).
 * Consecutive asterisks other than exactly `**` are invalid.
 */

const VALID_PATTERN_RE = /^[a-zA-Z0-9._\-*]+$/;

/**
 * Returns true if the pattern string is a valid glob pattern.
 *
 * Rules:
 *  - Only alphanumeric chars, dots, underscores, hyphens, and asterisks are allowed.
 *  - Consecutive asterisks are only permitted as exactly `**` (three or more in a row are invalid).
 */
export function isValidGlobPattern(pattern: string): boolean {
  if (!VALID_PATTERN_RE.test(pattern)) return false;
  // Reject runs of 3+ asterisks
  if (/\*{3,}/.test(pattern)) return false;
  return true;
}

/**
 * Returns true when `str` matches `pattern` using the glob rules described above.
 *
 * Matching is performed by converting the pattern into a regular expression:
 *  - `**` → matches zero-or-more dot-separated segments: `[^]* ` (anything)
 *  - `*`  → matches any sequence of non-dot characters within one segment
 *  - `.`  → literal dot
 *  - other chars → literal
 */
export function globMatch(pattern: string, str: string): boolean {
  // Build regex from pattern
  // Split on '**' first so we can handle it specially, then handle '*' within segments.
  const parts = pattern.split('**');
  const regexParts = parts.map((part) => {
    // Escape regex special chars except '*' and '.'
    return part
      .split('*')
      .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]*');
  });

  // Join the '**' parts with a pattern that matches any segment(s), including zero.
  // Between two '**' anchors we need to match: (nothing) OR (.<segment>)* style
  // Simplest approach: '**' matches any sequence of characters (including dots).
  const regexStr = '^' + regexParts.join('.*') + '$';

  const regex = new RegExp(regexStr);
  return regex.test(str);
}
