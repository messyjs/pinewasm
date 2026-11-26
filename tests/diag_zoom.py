from playwright.sync_api import sync_playwright

JS_TEST = """
() => {
  const cv = document.getElementById('chart');
  if (!cv) return {err: 'no canvas'};
  const r = cv.getBoundingClientRect();
  const shot = () => cv.toDataURL().length;
  const fire = (type, opts) => cv.dispatchEvent(new WheelEvent(type, opts));

  const s0 = shot();
  fire('wheel', {deltaY: -120, clientX: r.left + 400, clientY: r.top + 100, bubbles: true, cancelable: true});
  const s1 = shot();
  fire('wheel', {deltaY: -120, clientX: r.left + 400, clientY: r.top + 100, bubbles: true, cancelable: true});
  const s2 = shot();
  fire('wheel', {deltaY: +120, clientX: r.left + 400, clientY: r.top + 100, bubbles: true, cancelable: true});
  const s3 = shot();
  // shift+wheel pan
  fire('wheel', {deltaY: 100, shiftKey: true, clientX: r.left + 400, clientY: r.top + 100, bubbles: true, cancelable: true});
  const s4 = shot();
  const goliveHidden = document.getElementById('goLive').classList.contains('hidden');
  return {s0, zoomIn1: s1 !== s0, zoomIn2: s2 !== s1, zoomOut: s3 !== s2, pan: s4 !== s3, goliveHidden};
}
"""

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://127.0.0.1:9230')
    pg = b.contexts[0].pages[0]
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
    for _ in range(3):
        try:
            print('RESULT:', pg.evaluate(JS_TEST))
            break
        except Exception as ex:
            print('retry', ex)
    print('PAGEERRORS:', errors if errors else 'none')
    b.close()
