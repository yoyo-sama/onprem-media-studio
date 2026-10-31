// The assistant's little character: one inline SVG per place it appears, all showing
// the same mood. Moods: idle (floats, blinks), listening (leans in while the user
// types), thinking (looks up, dots), talking (mouth moves while the reply streams),
// happy (jumps, arms up: a render finished, or a click on it), sad (an error).
// It wears a costume for the role answering (a beret for the director, headphones for
// the editor…); a role without one keeps the white cap.
// Pure decoration: drawn and animated in CSS, it never changes what the page does.

const MOODS = new Set(["idle", "listening", "thinking", "talking", "happy", "sad"]);
const COSTUMES = new Set(["assistant", "director", "casting", "ad_director", "localisation", "campaign", "transitions"]);
let base = "idle", flash = null, flashTimer = 0, uid = 0, costume = "assistant";

function svg() {
  const n = ++uid, g = `mascotBody${n}`, c = `mascotCap${n}`;
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <radialGradient id="${g}" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe5ef"/></radialGradient>
    <linearGradient id="${c}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9dfe9"/></linearGradient>
  </defs>
  <ellipse class="m-shadow" cx="60" cy="113" rx="26" ry="4"/>
  <g class="m-all">
    <ellipse class="m-arm m-arm-l" cx="25" cy="80" rx="7" ry="11" fill="url(#${g})"/>
    <ellipse class="m-arm m-arm-r" cx="95" cy="80" rx="7" ry="11" fill="url(#${g})"/>
    <path class="m-body" d="M60 24C86 24 97 48 97 72C97 96 83 106 60 106C37 106 23 96 23 72C23 48 34 24 60 24Z" fill="url(#${g})"/>
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
      <g class="c c-glasses">
        <circle cx="47" cy="63" r="9.5"/><circle cx="73" cy="63" r="9.5"/>
        <path d="M56.5 62Q60 59 63.5 62M37.5 61 29 57M82.5 61 91 57"/>
      </g>
      <g class="c c-shades">
        <path d="M35 57H85" stroke="#1f2633" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M36 57H58Q58 70 47 70Q36 70 36 57ZM62 57H84Q84 70 73 70Q62 70 62 57Z" fill="#1f2633"/>
        <path d="M40 60L45 60M66 60L71 60" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
      </g>
    </g>
    <g class="c c-cap m-cap">
      <path d="M27 49C23 15 93 11 94 47Q62 55 27 49Z" fill="url(#${c})"/>
      <path d="M59 22C56 31 56 42 57 52M44 25C40 33 39 42 40 50M75 23C79 31 80 40 80 50" fill="none" stroke="#cfd6e2" stroke-width="1.1"/>
      <ellipse cx="76" cy="58" rx="17" ry="2.4" fill="rgba(15,23,42,0.12)"/>
      <path d="M56 51Q82 43 108 50Q110 55 102 57.5Q80 60 57 55.5Z" fill="#f4f6f9"/>
      <path d="M57 55.5Q80 60 102 57.5" fill="none" stroke="#c3cbd8" stroke-width="1.6"/>
      <circle cx="60" cy="21.5" r="3" fill="#ffffff"/>
    </g>
    <g class="c c-beret">
      <ellipse cx="56" cy="31" rx="31" ry="9.5" transform="rotate(-9 56 31)" fill="#8c1d2f"/>
      <path d="M33 39Q58 32 82 33" fill="none" stroke="#6b1524" stroke-width="4" stroke-linecap="round"/>
      <path d="M58 22 61 15" stroke="#8c1d2f" stroke-width="3" stroke-linecap="round"/>
    </g>
    <g class="c c-bowtie">
      <path d="M60 97 48 90.5V103.5ZM60 97 72 90.5V103.5Z" fill="#d6336c"/>
      <circle cx="60" cy="97" r="3.4" fill="#b02458"/>
    </g>
    <g class="c c-phones">
      <path d="M26 64C22 18 98 18 94 64" fill="none" stroke="#ef601b" stroke-width="5" stroke-linecap="round"/>
      <rect x="17" y="54" width="13" height="22" rx="6" fill="#ef601b"/><rect x="90" y="54" width="13" height="22" rx="6" fill="#ef601b"/>
      <rect x="20" y="58" width="5" height="14" rx="2.5" fill="#2b2f3a"/><rect x="95" y="58" width="5" height="14" rx="2.5" fill="#2b2f3a"/>
    </g>
    <g class="c c-headset">
      <path d="M27 62C24 20 96 20 93 62" fill="none" stroke="#0b5cab" stroke-width="3" stroke-linecap="round"/>
      <rect x="20" y="56" width="10" height="16" rx="5" fill="#0b5cab"/><rect x="90" y="56" width="10" height="16" rx="5" fill="#0b5cab"/>
      <path d="M25 71Q28 86 44 85" fill="none" stroke="#0b5cab" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="46" cy="85" r="3.2" fill="#1f2633"/>
    </g>
    <g class="m-dots"><circle cx="96" cy="22" r="3"/><circle cx="105" cy="15" r="3.6"/><circle cx="115" cy="8" r="4.2"/></g>
  </g>
</svg>`;
}

function apply() {
  const mood = flash || base;
  document.querySelectorAll(".mascot").forEach(el => { el.dataset.mood = mood; el.dataset.costume = costume; });
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

// The costume of the role answering (its id); an unknown role (one the user added)
// keeps the cap. A change makes it jump, as if it had just put the costume on.
export function setCostume(role) {
  const next = COSTUMES.has(role) ? role : "assistant";
  if (next === costume) return;
  costume = next;
  setMood("happy", 1200);
}
