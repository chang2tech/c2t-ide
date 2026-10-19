/**
 * Leak detection — client-side secret scanning for outgoing chat messages.
 * Wires `ide.general.leakDetectionEnabled` (Cursor's leakDetection concept):
 * before a prompt is submitted, it is scanned for secret-shaped values
 * (API keys, tokens, private keys). On a hit the user gets a modal choice —
 * nothing is ever sent silently.
 *
 * The patterns are deliberately conservative (high-entropy, prefixed formats)
 * to avoid flagging ordinary code. This is a safety net, not a vault.
 */

export interface SecretFinding {
  /** Human-readable label, e.g. "AWS access key". */
  label: string;
}

interface SecretPattern {
  label: string;
  re: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "AWS secret key", re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/i },
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: "GitHub PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9\-_]{10,}\b/ },
  { label: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", re: /\bxox[bpras]-[A-Za-z0-9\-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { label: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    label: "generic secret assignment",
    // api_key = "...", secret: '...', password=...  (min 8 non-space chars)
    re: /\b(api[_-]?key|api[_-]?secret|client[_-]?secret|auth[_-]?token|access[_-]?token|secret[_-]?key|private[_-]?token)\s*[:=]\s*['"]?\S{8,}['"]?/i,
  },
];

/**
 * Scan a prompt for secret-shaped values. Returns the distinct labels found
 * (empty = clean). Pure function — safe to unit test.
 */
export function scanPromptForSecrets(prompt: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    // Fresh regex state per pattern (all are global-flag-free, but reset anyway).
    p.re.lastIndex = 0;
    if (p.re.test(prompt) && !seen.has(p.label)) {
      seen.add(p.label);
      found.push({ label: p.label });
    }
  }
  return found;
}
