import assert from 'node:assert/strict';

import { renderPage } from '../src/lib/web/page.js';
import { onProgress, emitProgress, clearProgressListeners } from '../src/lib/progress.js';

describe('web ui', () => {
  it('injects the session nonce and leaves no placeholder behind', () => {
    const html = renderPage({ session: 'a'.repeat(32) });
    assert.ok(html.includes('const SESSION="' + 'a'.repeat(32) + '";'));
    assert.ok(!html.includes('__SESSION__'));
  });

  it('renders the controls the operator needs without external assets', () => {
    const html = renderPage({ session: 'b'.repeat(32) });
    for (const id of [ 'reload', 'start', 'clean', 'list', 'progressPanel', 'resultPanel' ]) {
      assert.ok(html.includes('id="' + id + '"'), id);
    }
    // A UI that needed a CDN would break on an offline machine.
    assert.ok(!/<script[^>]+src=/i.test(html));
    assert.ok(!/<link[^>]+href=/i.test(html));
  });

  it('offers select-all and search so the whole library is one click', () => {
    const html = renderPage({ session: 'c'.repeat(32) });
    assert.ok(html.includes('id="selectAll"'), 'select-all control');
    assert.ok(html.includes('id="search"'), 'search control');
    assert.ok(html.includes('id="count"'), 'selection counter');
    // The list must stay a single scroll container so 16 books are manageable.
    assert.ok(html.includes('id="list"'));
  });

  it('sends the whole selection in one export request', () => {
    const html = renderPage({ session: 'd'.repeat(32) });
    // The client posts every selected namespace at once rather than looping.
    assert.ok(html.includes('repos:[...selected]'));
    // Indeterminate state is what makes a partial selection honest.
    assert.ok(html.includes('indeterminate'));
  });

  it('stays self-contained: no remote styles or fonts', () => {
    const html = renderPage({ session: 'e'.repeat(32) });
    assert.ok(!/@import/i.test(html));
    assert.ok(!/url\(\s*['"]?https?:/i.test(html));
  });

  it('asks for a token on first run instead of showing an API error', () => {
    const html = renderPage({ session: 'f'.repeat(32) });
    // A fresh install has no token; the page must offer a way to provide one.
    assert.ok(html.includes('id="setupPanel"'), 'setup panel');
    assert.ok(html.includes('id="tokenInput"'), 'token field');
    assert.ok(html.includes('id="saveToken"'), 'save action');
    // The setup panel starts hidden and is revealed by the 401 from /api/repos.
    assert.ok(/id="setupPanel"[^>]*hidden/.test(html), 'setup panel starts hidden');
    assert.ok(html.includes('NO_TOKEN'), 'handles the no-token state');
  });

  it('keeps the previous export result out of the way during setup', () => {
    const html = renderPage({ session: 'h'.repeat(32) });
    // The poll loop refreshes results every 1.5s; without the setup guard it
    // would reveal a stale report underneath the token form.
    assert.ok(/if\(d\.report&&!inSetup\)/.test(html), 'poll respects setup state');
    assert.ok(html.includes('inSetup'), 'setup state is tracked');
    assert.ok(/if\(on\)\$\("progressPanel"\)\.hidden=true/.test(html), 'progress hidden during setup');
  });

  it('never renders the token into the page', () => {
    const html = renderPage({ session: 'g'.repeat(32) });
    // The value lives in the sidecar only; the page must always start empty.
    assert.ok(!/value="[A-Za-z0-9]{40}"/.test(html));
    assert.ok(html.includes('type="password"') || html.includes('autocomplete="off"'));
  });

  it('escapes nothing by accident when the session contains quotes', () => {
    const html = renderPage({ session: "x'</script>" });
    // The nonce is hex in practice; this guards against a template that would
    // let a value close the script tag if it were ever attacker controlled.
    assert.ok(!html.includes("x'</script>"));
  });
});

describe('progress listeners', () => {
  it('delivers events to subscribers and unsubscribes cleanly', () => {
    const seen: string[] = [];
    const off = onProgress(event => seen.push(event.type));
    emitProgress({ type: 'phase', phase: 'crawl' });
    emitProgress({ type: 'doc', namespace: 'a/b', status: 'exported' });
    off();
    emitProgress({ type: 'doc', namespace: 'a/b', status: 'failed' });
    assert.deepEqual(seen, [ 'phase', 'doc' ]);
  });

  it('keeps exporting when an observer throws', () => {
    clearProgressListeners();
    const seen: string[] = [];
    onProgress(() => { throw new Error('observer exploded'); });
    const off = onProgress(event => seen.push(event.type));
    assert.doesNotThrow(() => emitProgress({ type: 'phase', phase: 'build' }));
    assert.deepEqual(seen, [ 'phase' ]);
    off();
    clearProgressListeners();
  });
});
