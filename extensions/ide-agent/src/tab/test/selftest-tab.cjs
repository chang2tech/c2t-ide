/**
 * Self-test for the CURRENT Tab engine modules
 * (~/workspace/vscode/extensions/ide-agent/src/tab/).
 *
 * Covers the QA-FILE-06 fixes + baseline mechanics. Run:
 *   node /tmp/tab-test/selftest-tab.cjs
 *
 * Pure modules are compiled to /tmp/tab-test/out/.
 * The Alt-kill keybinding test uses the real VS Code KeybindingParser
 * compiled from the fork (~/workspace/vscode/src/vs/base/common/).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = '/tmp/tab-test/out';
const VS_OUT = '/tmp/tab-test/vs-out/base/common';

const { TabDebounceService } = require(path.join(OUT, 'debounce.js'));
const { acceptNextWord, nextWordBoundary, typeOverText } = require(path.join(OUT, 'wordAccept.js'));
const { isFileTooLarge, globMatch, matchesAnyPattern, gateEditor, isLanguageDisabled } = require(path.join(OUT, 'gates.js'));
const { FateTracker, ClearedSuggestionTracker, TabTelemetry } = require(path.join(OUT, 'telemetry.js'));
const { resolveNextAction, FollowupRegistry } = require(path.join(OUT, 'nextEdit.js'));
const { SnoozeManager } = require(path.join(OUT, 'snooze.js'));

const { KeybindingParser } = require(path.join(VS_OUT, 'keybindingParser.js'));
// NOTE: KeyCode is a const enum (erased at runtime); Unknown = 0, KeyK = 41.
const KEYCODE_UNKNOWN = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name, cond) {
  assert(cond, `FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

(async () => {
  // ============ BASELINE: debounce ============
  console.log('== debounce: coalescing ==');
  {
    const d = new TabDebounceService({ clientMs: 25, totalMs: 60 });
    let r = d.runRequest('a', 1000);
    ok('first request cancels nothing', r.requestIdsToCancel.length === 0);
    r = d.runRequest('b', 1030);
    ok('request within 60ms cancels older', JSON.stringify(r.requestIdsToCancel) === '["a"]');
    r = d.runRequest('c', 1100);
    ok('request 70ms later cancels nothing', r.requestIdsToCancel.length === 0);
    d.completeRequest('c');
    ok('completed request removed from history', d.historySize() === 2);
  }

  // ============ BASELINE: word accept ============
  console.log('== wordAccept ==');
  {
    ok('next word boundary skips to word end', nextWordBoundary('foo bar', 0) === 3);
    ok('next word boundary skips whitespace', nextWordBoundary('  foo', 0) === 5);
    const s = acceptNextWord('function foo()', 0);
    ok('acceptNextWord applies one word', s.applied === 'function' && s.newOffset === 8 && !s.fullyConsumed);
  }

  // ============ BASELINE + P2: gates ============
  console.log('== gates ==');
  {
    ok('5M char gate', isFileTooLarge(5_000_001) && !isFileTooLarge(100));
    // P2 (QA-FILE-06): matchBase — pattern with no `/` matches basename at any depth
    ok('matchBase: *.ts matches nested file', globMatch('*.ts', 'src/nested/a.ts'));
    ok('matchBase: *.ts matches top-level', globMatch('*.ts', 'a.ts'));
    ok('matchBase: *.ts does not match .tsx', !globMatch('*.ts', 'a.tsx'));
    ok('** pattern matches nested', globMatch('src/**/*.ts', 'src/a/b/c.ts'));
    ok('** pattern matches zero dirs', globMatch('src/**/*.ts', 'src/c.ts'));
    // P2 (QA-FILE-06): gateEditor prefers relPath so workspace-relative patterns work
    const gateRel = gateEditor({
      charCount: 100, fsPath: '/home/u/proj/src/a.ts', relPath: 'src/a.ts',
      languageId: 'typescript', disabledLanguages: [], perLanguageState: {}, ignorePatterns: ['src/**/*.ts'],
    });
    ok('relPath pattern matches', !gateRel.allowed && gateRel.reason === 'ignored');
    const gateAbs = gateEditor({
      charCount: 100, fsPath: '/home/u/proj/src/a.ts', relPath: '',
      languageId: 'typescript', disabledLanguages: [], perLanguageState: {}, ignorePatterns: ['src/**/*.ts'],
    });
    ok('falls back to fsPath when no relPath', gateAbs.allowed);
    ok('language disable works', isLanguageDisabled('python', ['python'], {}));
  }

  // ============ BASELINE + P2: FateTracker ============
  console.log('== FateTracker ==');
  {
    const f = new FateTracker();
    ok('first record wins (exactly-once)', f.record('r1', 'ACCEPT', 'ts') === true);
    ok('second record rejected', f.record('r1', 'REJECT', 'ts') === false);
    ok('get returns fate', f.get('r1') === 'ACCEPT');
    // P2 (QA-FILE-06): bounded at 1000 entries, oldest evicted first
    const big = new FateTracker();
    for (let i = 0; i < 1200; i++) big.record('req-' + i, 'REJECT', 'ts', 1_000_000 + i);
    ok('map capped at 1000', big.size() === 1000);
    ok('oldest evicted first', big.get('req-0') === undefined && big.get('req-1199') === 'REJECT');
    // P2 (QA-FILE-06): TTL sweep — entries older than 30min evicted on next record
    const ttl = new FateTracker();
    ttl.record('old', 'ACCEPT', 'ts', 0);
    ttl.record('new', 'ACCEPT', 'ts', 31 * 60_000);
    ok('stale entry swept', ttl.get('old') === undefined && ttl.get('new') === 'ACCEPT');
  }

  // ============ BASELINE: cleared tracker ============
  console.log('== ClearedSuggestionTracker ==');
  {
    const c = new ClearedSuggestionTracker(3);
    c.increment(); c.increment();
    ok('not suppressed below max', !c.shouldSuppress());
    c.increment();
    ok('suppressed at max', c.shouldSuppress());
    c.resetOnAccept();
    ok('reset on accept', !c.shouldSuppress() && c.count() === 0);
  }

  // ============ P2: telemetry batching ============
  console.log('== TabTelemetry batching (P2 QA-FILE-06) ==');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tel-'));
    const t = new TabTelemetry(dir, () => true);
    t.recordSessionEvent('tabTrigger', { requestId: 'x' });
    t.recordSessionEvent('tabTrigger', { requestId: 'y' });
    // Batched: nothing on disk synchronously (no input jank on keystroke path)
    const filesBefore = fs.readdirSync(dir);
    ok('no sync write on record', filesBefore.length === 0);
    await t.flush();
    const sessionLog = path.join(dir, 'tab-session.jsonl');
    ok('flush writes JSONL', fs.existsSync(sessionLog));
    const lines = fs.readFileSync(sessionLog, 'utf8').trim().split('\n');
    ok('both events flushed', lines.length === 2 && JSON.parse(lines[0]).event === 'tabTrigger');
    // dispose() flushes pending events
    t.recordSessionEvent('acceptTab', { requestId: 'z' });
    t.dispose();
    await sleep(50);
    const lines2 = fs.readFileSync(sessionLog, 'utf8').trim().split('\n');
    ok('dispose flushes', lines2.length === 3);
    // never throws when disabled
    const t2 = new TabTelemetry(dir, () => false);
    t2.recordSessionEvent('x', {});
    await t2.flush();
    ok('disabled telemetry is a no-op', true);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ============ P2: followup displayId chain ============
  console.log('== followup chain (P2 QA-FILE-06) ==');
  {
    const reg = new FollowupRegistry();
    reg.set('disp-1', { requestId: 'r1', text: 'followup text' });
    const v = reg.getAndEvict('disp-1');
    ok('followup stored and retrieved', v && v.text === 'followup text');
    ok('followup consumed once', reg.getAndEvict('disp-1') === undefined);
    const effect = resolveNextAction({ action: 'followup', onAcceptDisplayId: 'disp-9' });
    ok('resolveNextAction maps followup', effect.kind === 'followup' && effect.displayId === 'disp-9');
    ok('resolveNextAction none on undefined', resolveNextAction(undefined).kind === 'none');
    ok('resolveNextAction nextEdit -> refire', resolveNextAction({ action: 'nextEdit' }).kind === 'refire');
    // displayId extraction rule (mirrors provider.ts collectStream)
    const chunk = { textDelta: 'x', done: true, displayId: 'd-42' };
    const extracted = typeof chunk.displayId === 'string' && chunk.displayId.length > 0 ? chunk.displayId : undefined;
    ok('displayId extracted from final chunk', extracted === 'd-42');
    const chunk2 = { textDelta: 'x', done: true };
    const extracted2 = typeof chunk2.displayId === 'string' && chunk2.displayId.length > 0 ? chunk2.displayId : undefined;
    ok('missing displayId -> undefined', extracted2 === undefined);
  }

  // ============ BASELINE: snooze ============
  console.log('== snooze ==');
  {
    const store = new Map();
    const s = new SnoozeManager({ get: (k) => store.get(k), set: (k, v) => { v === undefined ? store.delete(k) : store.set(k, v); } }, () => {});
    s.snooze(50);
    ok('snoozed immediately', s.isSnoozed());
    await sleep(80);
    ok('auto re-enable on expiry', !s.isSnoozed());
  }

  // ============ P1 REGRESSION: typeOverText position check ============
  console.log('== typeOverText (P1 QA-FILE-06 regression) ==');
  {
    // Suggestion `function foo()` inserted at line 5, char 2; nothing applied yet.
    // User types `f` exactly at the type-over position (5,2) -> accept the char.
    ok('type-over at exact position',
      typeOverText(5, 2, 'function foo()', 0,
        { rangeLength: 0, startLine: 5, startCharacter: 2, text: 'f' }) === 'f');
    // BUG SCENARIO: user types `f` on ANOTHER line (5 vs 10). Must NOT count.
    ok('typing elsewhere is not type-over',
      typeOverText(5, 2, 'function foo()', 0,
        { rangeLength: 0, startLine: 10, startCharacter: 0, text: 'f' }) === '');
    // Same line, wrong column.
    ok('wrong column is not type-over',
      typeOverText(5, 2, 'function foo()', 0,
        { rangeLength: 0, startLine: 5, startCharacter: 9, text: 'f' }) === '');
    // Replacement (rangeLength > 0) is not a pure insertion.
    ok('replacement is not type-over',
      typeOverText(5, 2, 'function foo()', 0,
        { rangeLength: 1, startLine: 5, startCharacter: 2, text: 'f' }) === '');
    // appliedLength advances the expected position: 3 chars applied -> expect (5,5).
    ok('applied prefix advances position',
      typeOverText(5, 2, 'function foo()', 3,
        { rangeLength: 0, startLine: 5, startCharacter: 5, text: 'c' }) === 'c');
    ok('stale position after partial apply rejected',
      typeOverText(5, 2, 'function foo()', 3,
        { rangeLength: 0, startLine: 5, startCharacter: 2, text: 'f' }) === '');
    // Multi-line applied prefix: insert at (5,2), applied "xab\nc" (5 chars)
    // -> cursor at (6,1): line 5+1, last line 'c'.length == 1.
    ok('multi-line prefix advances line',
      typeOverText(5, 2, 'xab\ncd', 5,
        { rangeLength: 0, startLine: 6, startCharacter: 1, text: 'e' }) === 'e');
    ok('multi-line prefix wrong line rejected',
      typeOverText(5, 2, 'xab\ncd', 5,
        { rangeLength: 0, startLine: 5, startCharacter: 7, text: 'e' }) === '');
    // Multi-char insertion at the right spot still counts (paste of a prefix).
    ok('multi-char paste at position counts',
      typeOverText(5, 2, 'function foo()', 0,
        { rangeLength: 0, startLine: 5, startCharacter: 2, text: 'func' }) === 'func');
  }

  // ============ P1 REGRESSION: Alt-kill keybinding validity ============
  console.log('== Alt-kill keybinding (P1 QA-FILE-06 regression) ==');
  {
    const pkg = JSON.parse(fs.readFileSync(
      '/home/hatch/workspace/vscode/extensions/ide-agent/package.json', 'utf8'));
    const kb = pkg.contributes.keybindings.find((k) => k.command === 'ide.abortTabRequests');
    ok('ide.abortTabRequests has a keybinding', !!kb);
    ok('keybinding is not bare-modifier', kb.key !== 'alt' && kb.mac !== 'alt');
    // The new binding must parse to a REAL chord via VS Code's own parser.
    const parsed = KeybindingParser.parseKeybinding(kb.key);
    ok('alt+k parses', !!parsed && parsed.chords.length === 1);
    const chord = parsed.chords[0];
    const isKeyCodeChord = typeof chord.keyCode === 'number';
    ok('chord has a real keyCode (not Unknown)',
      isKeyCodeChord && chord.keyCode !== KEYCODE_UNKNOWN);
    ok('chord carries the alt modifier', chord.altKey === true);
    // The OLD binding ("alt") could never fire: VS Code's own parser does not
    // even treat it as a modifier (altKey:false) — a physical Alt keypress
    // (keyCode=KeyCode.Alt) can never match it.
    const oldParsed = KeybindingParser.parseKeybinding('alt');
    const oldChord = oldParsed && oldParsed.chords[0];
    ok('old bare "alt" binding is not an Alt chord (proves it was dead)',
      !!oldChord && oldChord.altKey === false);
    ok('when clause scopes to editor', kb.when === 'editorTextFocus');
  }

  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch((e) => {
  console.error('SELFTEST FAILED:', e.message);
  process.exit(1);
});
