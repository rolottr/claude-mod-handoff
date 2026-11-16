// Deterministic timeline helpers: every page defines DURATION (ms) and render(t).
const clamp = (x) => Math.max(0, Math.min(1, x));
const prog = (t, at, dur) => clamp((t - at) / dur);
const out3 = (x) => 1 - Math.pow(1 - x, 3);
const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// Fade/slide in at `at`, out at `outAt` (optional).
function vis(el, t, at, outAt = Infinity, dur = 350, dy = 12) {
  const k = out3(prog(t, at, dur)) * (1 - out3(prog(t, outAt, dur)));
  el.style.opacity = k;
  el.style.transform = `translateY(${(1 - out3(prog(t, at, dur))) * dy}px)`;
  return k;
}
// Typewriter: characters per second from `at`.
function typed(el, text, t, at, cps = 45) {
  const n = Math.max(0, Math.floor(((t - at) * cps) / 1000));
  el.textContent = text.slice(0, n);
  return n >= text.length;
}
function lerp(a, b, k) { return a + (b - a) * k; }
window.addEventListener('load', () => { if (!window.FRAME_MODE) { const s = performance.now(); const loop = () => { render((performance.now() - s) % DURATION); requestAnimationFrame(loop); }; loop(); } });
