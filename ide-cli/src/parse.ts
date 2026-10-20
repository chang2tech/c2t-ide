/**
 * parse.ts — argv parser for the IDE Code CLI.
 *
 * Spec: dig-cli §1 (dispatch order needs the first non-dash argv as the
 * subcommand candidate) and §2 (flag types drive value consumption).
 * Cursor's own parser is minimist-flavored; unknown flags are tolerated
 * into the open path (spec §2 intro). Where Cursor's exact edge behavior
 * is unobserved, the choice is marked.
 */

import { getOption, getOptionByAlias, isSubcommand, Subcommand } from "./options";

export type FlagValue = boolean | string | string[];

export interface ParsedArgv {
  /** Flag name (canonical, dashes kept) -> value. Aliases also set their canonical name. */
  flags: Record<string, FlagValue>;
  /** Positional arguments, in order (`--` terminator honored; `-` kept as-is). */
  _: string[];
  /** Unknown flags encountered, in order (collected, never fatal). */
  unknown: string[];
  /**
   * String flags given without a value (e.g. `--locale` with nothing after
   * it). Cursor prints `Option 'x' requires a non empty value. Ignoring the
   * option.` and continues (OBSERVED).
   */
  missingValue: string[];
  /**
   * Subcommand candidate: the FIRST RAW non-dash argv token that names a
   * known subcommand (desktop|tunnel|agent). This mirrors Cursor's `fl(e)`
   * / `Ln(...)` exactly (`e.find(f => f.length>0 && f[0]!=="-")`) — it is a
   * raw scan, so `--locale desktop` DOES route to the bridge, and tokens
   * after `--` are still scanned. Do not "improve" this: it is observed
   * behavior.
   */
  subcommand?: Subcommand;
  /** Index of the subcommand token inside the raw argv (for slicing `rest`). */
  subcommandIndex?: number;
}

function setFlag(out: ParsedArgv, name: string, value: FlagValue): void {
  out.flags[name] = value;
  const opt = getOption(name);
  // Mirror minimist alias behavior: the alias key is set too.
  if (opt?.alias) {
    out.flags[opt.alias] = value;
  }
}

function appendValue(out: ParsedArgv, name: string, value: string): void {
  const opt = getOption(name);
  if (opt?.type === "string[]") {
    const cur = out.flags[name];
    const arr = Array.isArray(cur) ? (cur as string[]) : [];
    arr.push(value);
    setFlag(out, name, arr);
  } else {
    setFlag(out, name, value);
  }
}

function isFlagToken(tok: string): boolean {
  return tok.length > 1 && tok.startsWith("-") && tok !== "-";
}

export function parseArgv(argv: string[]): ParsedArgv {
  const out: ParsedArgv = { flags: {}, _: [], unknown: [], missingValue: [] };
  let endOfFlags = false;
  let i = 0;

  const takeValue = (): string | undefined => {
    const next = argv[i + 1];
    if (next !== undefined && !isFlagToken(next)) {
      i++;
      return next;
    }
    return undefined;
  };

  while (i < argv.length) {
    const tok = argv[i];

    if (endOfFlags) {
      out._.push(tok);
      i++;
      continue;
    }

    if (tok === "--") {
      endOfFlags = true;
      i++;
      continue;
    }

    // Long flag: --name or --name=value
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const rawName = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const eqValue = eq === -1 ? undefined : tok.slice(eq + 1);
      const opt = getOption(rawName);

      if (!opt) {
        // Unknown flag: tolerated (spec §2 intro). Minimist-flavored:
        // --foo=bar -> "bar"; --foo <non-dash> -> consume as value; else true.
        out.unknown.push(rawName);
        if (eqValue !== undefined) {
          out.flags[rawName] = eqValue;
        } else {
          const v = takeValue();
          out.flags[rawName] = v === undefined ? true : v;
        }
        i++;
        continue;
      }

      if (opt.type === "bool") {
        if (eqValue !== undefined) {
          const v = eqValue.toLowerCase();
          setFlag(out, opt.name, v === "false" || v === "0" || v === "no" ? false : true);
        } else {
          setFlag(out, opt.name, true);
        }
      } else if (eqValue !== undefined) {
        appendValue(out, opt.name, eqValue);
      } else {
        const v = takeValue();
        if (v === undefined) {
          // Cursor: `Option 'x' requires a non empty value. Ignoring the option.`
          // (OBSERVED for --locate-shell-integration-path with no value.)
          out.missingValue.push(opt.name);
        } else {
          appendValue(out, opt.name, v);
        }
      }
      i++;
      continue;
    }

    // Short flag(s): -x or -xyz cluster
    if (tok.startsWith("-") && tok !== "-") {
      const cluster = tok.slice(1);
      let consumed = false;
      for (let c = 0; c < cluster.length; c++) {
        const ch = cluster[c];
        const opt = getOptionByAlias(ch);
        if (!opt) {
          out.unknown.push(ch);
          continue;
        }
        if (opt.type === "bool") {
          setFlag(out, opt.name, true);
        } else {
          // String flag inside a cluster: rest of cluster is the value
          // (standard minimist behavior); else take the next token.
          const rest = cluster.slice(c + 1);
          if (rest.length > 0) {
            appendValue(out, opt.name, rest);
          } else {
            const v = takeValue();
            if (v === undefined) {
              out.missingValue.push(opt.name);
            } else {
              appendValue(out, opt.name, v);
            }
          }
          consumed = true;
          break;
        }
      }
      void consumed;
      i++;
      continue;
    }

    // Positional (includes lone "-")
    out._.push(tok);
    i++;
  }

  // Subcommand candidate: raw scan for the first non-dash token naming a
  // known subcommand — exactly Cursor's `fl(e)` / `Ln(...)`:
  // `e.find(f => f.length>0 && f[0]!=="-")`. Flag values and `--` do NOT
  // shield the token (OBSERVED binary behavior).
  const rawSub = argv.find((t) => t.length > 0 && t[0] !== "-");
  if (rawSub !== undefined && isSubcommand(rawSub)) {
    out.subcommand = rawSub;
    out.subcommandIndex = argv.indexOf(rawSub);
  }

  return out;
}

/** Convenience: was the flag given (bool true, or any string value)? */
export function hasFlag(parsed: ParsedArgv, name: string): boolean {
  const v = parsed.flags[name];
  return v === true || (typeof v === "string" && v.length > 0) || (Array.isArray(v) && v.length > 0);
}

/** String value of a flag (first value for string[]), or undefined. */
export function flagString(parsed: ParsedArgv, name: string): string | undefined {
  const v = parsed.flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}
