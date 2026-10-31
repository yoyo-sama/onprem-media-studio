// The assistant's little character: one inline SVG per place it appears, all showing
// the same mood. Moods: idle (floats, blinks), listening (leans in while the user
// types), thinking (looks up, dots), talking (mouth moves while the reply streams),
// happy (jumps, arms up: a render finished, or a click on it), sad (an error).
// Pure decoration: drawn and animated in CSS, it never changes what the page does.

const MOODS = new Set(["idle", "listening", "thinking", "talking", "happy", "sad"]);
let base = "idle", flash = null, flashTimer = 0, uid = 0;

function svg() {
  const n = ++uid, g = `mascotBody${n}`, c = `mascotCap${n}`;
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <radialGradient id="${g}" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe5ef"/></radialGradient>
    <linearGradient id="${c}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#343ced"/><stop offset="1" stop-color="#0b5cab"/></linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="113" rx="26" ry="4"/>
  <g class="m-all">
    <ellipse class="m-arm m-arm-l" cx="25" cy="80" rx="7" ry="11" fill="url(#${g})"/>
    <ellipse class="m-arm m-arm-r" cx="95" cy="80" rx="7" ry="11" fill="url(#${g})"/>
    <path class="m-body" d="M60 24C86 24 97 48 97 72C97 96 83 106 60 106C37 106 23 96 23 72C23 48 34 24 60 24Z" fill="url(#${g})"/>
    <g class="m-cap">
      <path d="M31 47C31 24 89 24 89 47C78 43 42 43 31 47Z" fill="url(#${c})"/>
      <path d="M62 44C80 41 100 42 108 49C96 52 78 51 62 50Z" fill="#0b5cab"/>
      <circle cx="60" cy="27.5" r="3" fill="#a9e0ff"/>
    </g>
    <g class="m-face">
      <g class="m-eyes">
        <ellipse cx="47" cy="63" rx="5" ry="7" fill="#1f2633"/><circle cx="48.6" cy="60.4" r="1.8" fill="#fff"/>
        <ellipse cx="73" cy="63" rx="5" ry="7" fill="#1f2633"/><circle cx="74.6" cy="60.4" r="1.8" fill="#fff"/>
      </g>
      <ellipse class="m-cheek" cx="37" cy="75" rx="6" ry="3.5"/>
      <ellipse class="m-cheek" cx="83" cy="75" rx="6" ry="3.5"/>
      <path class="m-mouth m-smile" d="M52 76Q60 85 68 76"/>
      <path class="m-mouth m-open" d="M51 75Q60 74 69 75Q67 91 60 91Q53 91 51 75Z"/>
      <path class="m-mouth m-sad" d="M53 83Q60 76 67 83"/>
    </g>
    <g class="m-dots"><circle cx="96" cy="22" r="3"/><circle cx="105" cy="15" r="3.6"/><circle cx="115" cy="8" r="4.2"/></g>
  </g>
</svg>`;
}

function apply() {
  const mood = flash || base;
  document.querySelectorAll(".mascot").forEach(el => { el.dataset.mood = mood; });
}

// Draws the character into every `.mascot` element still empty.
export function drawMascots() {
  document.querySelectorAll(".mascot:empty").forEach(el => {
    el.innerHTML = svg();
    // A click makes it wave: the only thing it does.
    el.addEventListener("click", () => setMood("happy", 1600));
  });
  apply();
}

// `ms` given: a passing mood, then back to the lasting one.
export function setMood(mood, ms) {
  if (!MOODS.has(mood)) return;
  if (ms) {
    flash = mood;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; apply(); }, ms);
  } else base = mood;
  apply();
}
