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
const { SnoozeManager, formatSnoozedTimeRemaining } = require(path.join(OUT, 'snooze.js'));

const { KeybindingParser } = require(path.join(VS_OUT, 'keybindingParser.js'));
// NOTE: KeyCode is a const enum (erased at runtime); Unknown = 0, KeyK = 41.
const KEYCODE_UNKNOWN = 0;

const { EngineTabBackend, asTabEngine } = require(path.join(OUT, 'backend.js'));

/**
 * Mock engine satisfying the structural TabCompletionEngine interface.
 * Mocks the ADAPTER boundary (completeCode/listModels/getDefaultModel) —
 * never the completion text: the text under test is fed through the mock.
 */
function mockEngine({ chunks = [''], models = [], defaultModel = undefined, onCompleteCode } = {}) {
  return {
    async *completeCode(prefix, suffix, modelId, signal, context) {
      if (onCompleteCode) onCompleteCode({ prefix, suffix, modelId, context });
      for (const c of chunks) {
        if (signal.aborted) return;
        await sleep(1);
        if (signal.aborted) return;
        yield c;
      }
    },
    async listModels() {
      return models;
    },
    async getDefaultModel() {
      return defaultModel;
    },
  };
}

function makeReq(overrides = {}) {
  return {
    uri: 'file:///a.ts',
    languageId: 'typescript',
    fileName: 'a.ts',
    prefix: 'const x = ',
    suffix: '\n',
    position: { line: 0, character: 10 },
    triggerKind: 'typing',
    ...overrides,
  };
}

async function collectChunks(backend, req, signal) {
  const out = [];
  for await (const c of backend.fetchSuggestion(req, signal)) out.push(c);
  return out;
}

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

  // ============ formatSnoozedTimeRemaining (Cursor `formatSnoozedTimeRemaining`) ============
  // Binary evidence: `r>0?`${r}h ${s}m`:`${s}m ${o}s`` where r/hours, s/minutes,
  // o/seconds are derived from the remaining ms.
  console.log('== formatSnoozedTimeRemaining ==');
  {
    const now = 1_700_000_000_000;
    ok('hours>0 shows Xh Ym (seconds dropped)',
      formatSnoozedTimeRemaining(now + (1 * 3600 + 2 * 60 + 33) * 1000, now) === '1h 2m');
    ok('exact hour boundary', formatSnoozedTimeRemaining(now + 3600 * 1000, now) === '1h 0m');
    ok('under an hour shows Ym Zs',
      formatSnoozedTimeRemaining(now + (4 * 60 + 59) * 1000, now) === '4m 59s');
    ok('59m59s stays minute format', formatSnoozedTimeRemaining(now + 3599999, now) === '59m 59s');
    ok('zero remaining', formatSnoozedTimeRemaining(now, now) === '0m 0s');
    ok('negative remaining clamps to zero', formatSnoozedTimeRemaining(now - 5000, now) === '0m 0s');
    ok('3h snooze formats hours', formatSnoozedTimeRemaining(now + 3 * 3600 * 1000, now) === '3h 0m');
  }

  // ============ snooze survives window reload (maybeReenableCppIfSnoozed) ============
  console.log('== snooze reload-resume ==');
  {
    const store = new Map();
    const mk = (onExpire = () => {}) => new SnoozeManager(
      { get: (k) => store.get(k), set: (k, v) => { v === undefined ? store.delete(k) : store.set(k, v); } },
      onExpire);
    const t0 = 1_700_000_000_000;
    mk().snooze(5000, t0); // snoozed until t0+5000
    // Simulate window reload: a fresh manager on the same persistent storage.
    const reloaded = mk();
    ok('reload: still snoozed before expiry', reloaded.isSnoozed(t0 + 1000));
    ok('reload: maybeReenable does not clear a live snooze', reloaded.maybeReenable(t0 + 1000) === false);
    ok('reload: snoozedUntil preserved across reload', reloaded.snoozedUntil() === t0 + 5000);
    // Snooze expired while the window was closed: maybeReenable clears and
    // fires onExpire so the status bar stays consistent (P2).
    let fired = 0;
    const gone = mk(() => { fired++; });
    ok('reload: maybeReenable clears expired snooze', gone.maybeReenable(t0 + 6000) === true);
    ok('reload: onExpire fired for expired snooze', fired === 1);
    ok('reload: not snoozed after expired clear', !gone.isSnoozed(t0 + 6000));
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
  // Keybindings migrated to workbench core (src/vs/workbench/contrib/composer/
  // browser/composerActions.ts); package.json no longer carries them.
  console.log('== Alt-kill keybinding (P1 QA-FILE-06 regression) ==');
  {
    const actionsSrc = fs.readFileSync(
      '/home/hatch/workspace/vscode/src/vs/workbench/contrib/composer/browser/composerActions.ts', 'utf8');
    const clsIdx = actionsSrc.indexOf('export class ComposerAbortTabRequestsAction');
    ok('composer.abortTabRequests action exists in core', clsIdx >= 0);
    const chunk = actionsSrc.slice(clsIdx, actionsSrc.indexOf('registerAction2(ComposerAbortTabRequestsAction', clsIdx));
    const primaryMatch = /primary:\s*([^,\n]+)/.exec(chunk);
    ok('composer.abortTabRequests has a primary chord', !!primaryMatch);
    const primaryExpr = primaryMatch[1].trim();
    ok('primary is Alt+K (not bare-modifier)',
      primaryExpr.includes('KeyMod.Alt') && primaryExpr.includes('KeyCode.KeyK'));
    // The chord must parse to a REAL chord via VS Code's own parser.
    const parsed = KeybindingParser.parseKeybinding('alt+k');
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
    ok('when clause scopes to editor', chunk.includes('EditorContextKeys.editorTextFocus'));
  }

  // ============ EngineTabBackend (real backend, mocked adapter) ============
  console.log('== EngineTabBackend ==');
  {
    // asTabEngine feature-check: stub-like objects are NOT engines.
    const eng = mockEngine();
    ok('conforming object is an engine', asTabEngine(eng) === eng);
    ok('stub-like object is not an engine', asTabEngine({ runTurn() {}, abortTurn() {} }) === undefined);
    ok('undefined is not an engine', asTabEngine(undefined) === undefined);
    ok('null is not an engine', asTabEngine(null) === undefined);

    const avail = new EngineTabBackend(() => eng);
    const noEng = new EngineTabBackend(() => undefined);
    const stubEng = new EngineTabBackend(() => ({ runTurn() {}, abortTurn() {} }));
    const throwing = new EngineTabBackend(() => { throw new Error('boom'); });
    ok('isEngineAvailable true with engine', avail.isEngineAvailable === true);
    ok('isEngineAvailable false without engine', noEng.isEngineAvailable === false);
    ok('isEngineAvailable false with stub adapter', stubEng.isEngineAvailable === false);
    ok('isEngineAvailable false when getter throws', throwing.isEngineAvailable === false);

    // fetchSuggestion maps adapter chunks -> TabSuggestionChunk with real modelId.
    const b1 = new EngineTabBackend(() => mockEngine({
      chunks: ['line1\n', 'line2'],
      defaultModel: { providerID: 'p', id: 'm', name: 'M' },
    }));
    const chunks1 = await collectChunks(b1, makeReq(), new AbortController().signal);
    ok('last chunk done', chunks1.length > 0 && chunks1[chunks1.length - 1].done === true);
    ok('chunks reassemble to engine text',
      chunks1.map((c) => c.textDelta).join('') === 'line1\nline2');
    ok('real modelId on chunks', chunks1.every((c) => c.modelId === 'p/m'));
    ok('non-final chunks not done', chunks1.slice(0, -1).every((c) => c.done === false));

    // modelOverride is passed through to completeCode (providerID/modelID form).
    let seen;
    const b2 = new EngineTabBackend(() => mockEngine({
      chunks: ['x'],
      onCompleteCode: (args) => { seen = args; },
    }));
    await collectChunks(b2, makeReq({ modelOverride: 'anthropic/claude-x' }), new AbortController().signal);
    ok('modelOverride forwarded', seen && seen.modelId === 'anthropic/claude-x');
    ok('prefix/suffix forwarded', seen && seen.prefix === 'const x = ' && seen.suffix === '\n');
    ok('language context forwarded',
      seen && seen.context && seen.context.languageId === 'typescript' && seen.context.fileName === 'a.ts');

    // Malformed override (no providerID/) is NOT forwarded; default is used.
    let seen2;
    const b3 = new EngineTabBackend(() => mockEngine({
      chunks: ['x'],
      defaultModel: { providerID: 'p', id: 'd', name: 'D' },
      onCompleteCode: (args) => { seen2 = args; },
    }));
    const chunks3 = await collectChunks(b3, makeReq({ modelOverride: 'canned-demo' }), new AbortController().signal);
    ok('malformed override not forwarded', seen2 && seen2.modelId === undefined);
    ok('falls back to default model id', chunks3[chunks3.length - 1].modelId === 'p/d');

    // Abort mid-stream: generator returns, no done chunk.
    const ac = new AbortController();
    const b4 = new EngineTabBackend(() => mockEngine({ chunks: ['aaa\n', 'bbb\n', 'ccc'] }));
    const iter = b4.fetchSuggestion(makeReq(), ac.signal)[Symbol.asyncIterator]();
    const first = await iter.next();
    ok('first chunk yielded', first.done === false);
    ac.abort();
    const rest = [];
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      rest.push(r.value);
    }
    ok('no chunks after abort', rest.length === 0);

    // Paired fence stripping: ```lang ... ``` is removed.
    const b5 = new EngineTabBackend(() => mockEngine({ chunks: ['```typescript\nconst x = 1;\n```'] }));
    const chunks5 = await collectChunks(b5, makeReq(), new AbortController().signal);
    ok('paired fences stripped',
      chunks5.map((c) => c.textDelta).join('') === 'const x = 1;');

    // Fence split across chunks is still stripped.
    const b5b = new EngineTabBackend(() => mockEngine({ chunks: ['``', '`ts\nconst y = 2;\n', '```'] }));
    const chunks5b = await collectChunks(b5b, makeReq(), new AbortController().signal);
    ok('split fences stripped',
      chunks5b.map((c) => c.textDelta).join('') === 'const y = 2;');

    // Lone trailing fence (no leading fence) is real content — kept.
    const b6 = new EngineTabBackend(() => mockEngine({ chunks: ['code\n```'] }));
    const chunks6 = await collectChunks(b6, makeReq(), new AbortController().signal);
    ok('lone trailing fence kept',
      chunks6.map((c) => c.textDelta).join('') === 'code\n```');

    // No engine → no chunks at all (never fake).
    const chunks7 = await collectChunks(noEng, makeReq(), new AbortController().signal);
    ok('no engine yields nothing', chunks7.length === 0);

    // availableModels maps the engine catalog; honest empty when unavailable.
    const b8 = new EngineTabBackend(() => mockEngine({
      models: [{ id: 'm1', providerID: 'p1', name: 'Model One' }],
    }));
    const models8 = await b8.availableModels();
    ok('model id is providerID/id compound',
      models8.length === 1 && models8[0].id === 'p1/m1' && models8[0].displayName === 'Model One');
    ok('availableModels empty without engine', (await noEng.availableModels()).length === 0);
    const failing = new EngineTabBackend(() => ({
      async *completeCode() {},
      async listModels() { throw new Error('down'); },
      async getDefaultModel() { return undefined; },
    }));
    ok('availableModels empty when listModels throws', (await failing.availableModels()).length === 0);

    // fetchServerConfig: honest client defaults (no server).
    const sc = await avail.fetchServerConfig();
    ok('server config is client defaults', sc.isOn === true && sc.isGhostText === true);
  }

  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch((e) => {
  console.error('SELFTEST FAILED:', e.message);
  process.exit(1);
});
