"use strict";
/**
 * parse.ts — argv parser for the IDE Code CLI.
 *
 * Spec: dig-cli §1 (dispatch order needs the first non-dash argv as the
 * subcommand candidate) and §2 (flag types drive value consumption).
 * Cursor's own parser is minimist-flavored; unknown flags are tolerated
 * into the open path (spec §2 intro). Where Cursor's exact edge behavior
 * is unobserved, the choice is marked.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgv = parseArgv;
exports.hasFlag = hasFlag;
exports.flagString = flagString;
const options_1 = require("./options");
function setFlag(out, name, value) {
    out.flags[name] = value;
    const opt = (0, options_1.getOption)(name);
    // Mirror minimist alias behavior: the alias key is set too.
    if (opt?.alias) {
        out.flags[opt.alias] = value;
    }
}
function appendValue(out, name, value) {
    const opt = (0, options_1.getOption)(name);
    if (opt?.type === "string[]") {
        const cur = out.flags[name];
        const arr = Array.isArray(cur) ? cur : [];
        arr.push(value);
        setFlag(out, name, arr);
    }
    else {
        setFlag(out, name, value);
    }
}
function isFlagToken(tok) {
    return tok.length > 1 && tok.startsWith("-") && tok !== "-";
}
function parseArgv(argv) {
    const out = { flags: {}, _: [], unknown: [], missingValue: [] };
    let endOfFlags = false;
    let i = 0;
    const takeValue = () => {
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
            const opt = (0, options_1.getOption)(rawName);
            if (!opt) {
                // Unknown flag: tolerated (spec §2 intro). Minimist-flavored:
                // --foo=bar -> "bar"; --foo <non-dash> -> consume as value; else true.
                out.unknown.push(rawName);
                if (eqValue !== undefined) {
                    out.flags[rawName] = eqValue;
                }
                else {
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
                }
                else {
                    setFlag(out, opt.name, true);
                }
            }
            else if (eqValue !== undefined) {
                appendValue(out, opt.name, eqValue);
            }
            else {
                const v = takeValue();
                if (v === undefined) {
                    // Cursor: `Option 'x' requires a non empty value. Ignoring the option.`
                    // (OBSERVED for --locate-shell-integration-path with no value.)
                    out.missingValue.push(opt.name);
                }
                else {
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
                const opt = (0, options_1.getOptionByAlias)(ch);
                if (!opt) {
                    out.unknown.push(ch);
                    continue;
                }
                if (opt.type === "bool") {
                    setFlag(out, opt.name, true);
                }
                else {
                    // String flag inside a cluster: rest of cluster is the value
                    // (standard minimist behavior); else take the next token.
                    const rest = cluster.slice(c + 1);
                    if (rest.length > 0) {
                        appendValue(out, opt.name, rest);
                    }
                    else {
                        const v = takeValue();
                        if (v === undefined) {
                            out.missingValue.push(opt.name);
                        }
                        else {
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
    if (rawSub !== undefined && (0, options_1.isSubcommand)(rawSub)) {
        out.subcommand = rawSub;
        out.subcommandIndex = argv.indexOf(rawSub);
    }
    return out;
}
/** Convenience: was the flag given (bool true, or any string value)? */
function hasFlag(parsed, name) {
    const v = parsed.flags[name];
    return v === true || (typeof v === "string" && v.length > 0) || (Array.isArray(v) && v.length > 0);
}
/** String value of a flag (first value for string[]), or undefined. */
function flagString(parsed, name) {
    const v = parsed.flags[name];
    if (typeof v === "string")
        return v;
    if (Array.isArray(v) && v.length > 0)
        return v[0];
    return undefined;
}
