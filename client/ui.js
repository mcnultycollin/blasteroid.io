/**
 * DOM overlays: join menu with the ship class picker, death screen (where the
 * class can be changed before flying again) and connection toast. User text
 * only ever goes into textContent.
 */
import { CLASSES, CLASS_COUNT } from '../shared/stats.js';
import { ThrusterMode } from './input.js';
import { traceHull, traceHullDetails } from './renderer.js';

const NAME_KEY = 'blasteroid.name';
const CLASS_KEY = 'blasteroid.class';
const THRUSTER_KEY = 'blasteroid.thrusters';
const THRUSTER_TEXT = {
  [ThrusterMode.SCREEN]: ['up · left · down · right on screen', 'They push the same way on screen whichever way your ship faces.'],
  [ThrusterMode.SHIP]: ['forward · left · back · right of the ship', 'They push relative to your nose, so their directions turn with the ship.'],
};

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
  /**
   * `handlers.play(name)` is called when the player asks to (re)spawn;
   * `handlers.thrusterMode(mode)` when the W/A/S/D setting changes.
   */
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
    this.devHint = $('dev-hint');
    this.teamNote = $('team-note');
    this.thrusterButton = $('thruster-mode');
    this.thrusterHint = $('thruster-hint');

    this.nameInput.value = readStorage(NAME_KEY);
    const saved = Number.parseInt(readStorage(CLASS_KEY), 10);
    this.selectedClass = saved >= 0 && saved < CLASS_COUNT ? saved : 0;
    this.pickers = [this.buildPicker($('classes'), $('class-desc')), this.buildPicker($('death-classes'), $('death-class-desc'))];
    this.selectClass(this.selectedClass);

    const mode = readStorage(THRUSTER_KEY);
    this.thrusters = THRUSTER_TEXT[mode] ? mode : ThrusterMode.SCREEN;
    this.onThrusterMode = handlers.thrusterMode;
    this.thrusterButton.addEventListener('click', () =>
      this.setThrusterMode(this.thrusters === ThrusterMode.SCREEN ? ThrusterMode.SHIP : ThrusterMode.SCREEN),
    );
    this.setThrusterMode(this.thrusters);
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

  /** The ship class picked for the next spawn. */
  shipClass() {
    return this.selectedClass;
  }

  /** One row of class cards (each with a drawing of its hull) and a description line. */
  buildPicker(row, desc) {
    const cards = CLASSES.map((c, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'class-card';
      const icon = document.createElement('canvas');
      icon.width = icon.height = 88;
      drawIcon(icon, i);
      const name = document.createElement('strong');
      name.textContent = c.name.toUpperCase();
      const role = document.createElement('span');
      role.textContent = c.role;
      card.append(icon, name, role);
      card.addEventListener('click', () => this.selectClass(i));
      row.append(card);
      return card;
    });
    return { cards, desc };
  }

  selectClass(index) {
    this.selectedClass = index;
    writeStorage(CLASS_KEY, String(index));
    const c = CLASSES[index];
    for (const { cards, desc } of this.pickers) {
      cards.forEach((card, i) => card.setAttribute('aria-pressed', String(i === index)));
      const ability = document.createElement('b');
      ability.textContent = `[E] ${c.ability.name}`;
      desc.replaceChildren(ability, ` · ${c.desc}`);
    }
  }

  /** The W/A/S/D thruster mode (see ThrusterMode), shown on the menu and remembered. */
  setThrusterMode(mode) {
    this.thrusters = mode;
    writeStorage(THRUSTER_KEY, mode);
    const [label, hint] = THRUSTER_TEXT[mode];
    this.thrusterButton.textContent = label;
    this.thrusterHint.textContent = `${hint} Click to switch.`;
    this.onThrusterMode?.(mode);
  }

  setTeams(enabled) {
    this.teamNote.classList.toggle('hidden', !enabled);
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

  setDevTools(enabled) {
    this.devHint.classList.toggle('hidden', !enabled);
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

/** Draws a class's hull, nose up, centred in a card's canvas. */
function drawIcon(canvas, shipClass) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 2);
  const r = size * 0.28 * (CLASSES[shipClass].radius / 18);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  traceHull(ctx, shipClass, r);
  ctx.fillStyle = 'rgba(92, 242, 255, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#e8ecff';
  ctx.lineWidth = 3;
  ctx.stroke();
  traceHullDetails(ctx, shipClass, r);
  ctx.lineWidth = 2.5;
  ctx.stroke();
}
