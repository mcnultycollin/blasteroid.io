/** DOM overlays: join menu, death screen and connection toast. User text only ever goes into textContent. */
const NAME_KEY = 'blasteroid.name';

function readStorage(key) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; not essential
  }
}

export class Ui {
  /** `handlers.play(name)` is called when the player asks to (re)spawn. */
  constructor(handlers) {
    const $ = (id) => document.getElementById(id);
    this.menu = $('menu');
    this.form = $('join-form');
    this.nameInput = $('name');
    this.playButton = $('play');
    this.status = $('status');
    this.death = $('death');
    this.deathTitle = $('death-title');
    this.deathCause = $('death-cause');
    this.deathStats = $('death-stats');
    this.againButton = $('again');
    this.toast = $('toast');

    this.nameInput.value = readStorage(NAME_KEY);
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      handlers.play(this.name());
    });
    this.againButton.addEventListener('click', () => handlers.play(this.name()));
  }

  name() {
    const name = this.nameInput.value.trim();
    writeStorage(NAME_KEY, name);
    return name;
  }

  get menuVisible() {
    return !this.menu.classList.contains('hidden');
  }

  get deathVisible() {
    return !this.death.classList.contains('hidden');
  }

  showMenu() {
    this.menu.classList.remove('hidden');
    this.playButton.disabled = false;
    if (!matchMedia('(pointer: coarse)').matches) this.nameInput.focus();
  }

  hideMenu() {
    this.menu.classList.add('hidden');
    this.nameInput.blur();
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  setPlayEnabled(enabled) {
    this.playButton.disabled = !enabled;
    this.againButton.disabled = !enabled;
  }

  /** `info`: { title, cause, stats: [[label, value], ...] } */
  showDeath(info) {
    this.deathTitle.textContent = info.title;
    this.deathCause.textContent = info.cause;
    this.deathStats.replaceChildren(
      ...info.stats.map(([label, value]) => {
        const cell = document.createElement('div');
        const v = document.createElement('strong');
        v.textContent = value;
        const l = document.createElement('span');
        l.textContent = label;
        cell.append(v, l);
        return cell;
      }),
    );
    this.death.classList.remove('hidden');
    this.againButton.focus();
  }

  hideDeath() {
    this.death.classList.add('hidden');
  }

  showToast(text) {
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
  }

  hideToast() {
    this.toast.classList.add('hidden');
  }
}
