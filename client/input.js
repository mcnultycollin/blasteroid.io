/**
 * Keyboard, mouse and touch input, folded into one command per tick:
 * a Button bitmask plus an aim angle.
 *
 * Two steering styles coexist: classic rotate keys (arrows), or aiming with
 * the mouse, where the ship turns towards the cursor at its turn rate.
 * Moving the mouse switches to aiming; pressing a rotate key switches back.
 * W/A/S/D fire the ship's forward, lateral and reverse thrusters, so it can
 * accelerate in any direction while the nose stays on target.
 */
import { Button } from '../shared/constants.js';

const KEY_BUTTONS = {
  ArrowUp: Button.THRUST,
  ArrowLeft: Button.LEFT,
  ArrowRight: Button.RIGHT,
  ArrowDown: Button.BRAKE,
  KeyW: Button.THRUST,
  KeyS: Button.BACK,
  KeyA: Button.STRAFE_LEFT,
  KeyD: Button.STRAFE_RIGHT,
  KeyQ: Button.BRAKE,
  KeyP: Button.BLAST,
  Space: Button.FIRE,
  ShiftLeft: Button.BOOST,
  ShiftRight: Button.BOOST,
};
const WEAPON_KEYS = { KeyZ: 0, KeyX: 1, KeyC: 2 };
const TOUCH_HOLD = { blast: Button.BLAST, brake: Button.BRAKE }; // on-screen buttons held down by a finger
const STICK_DEADZONE = 14; // px
const STICK_BOOST = 85; // px: pushing the stick this far engages boost

/**
 * `actions` callbacks: upgrade(stat), weapon(choiceIndex), respawn(),
 * toggleMute(), toggleStealth(), toggleDebug(),
 * hudPress(x, y) -> null, or the HUD action under the press ({type: ...}).
 */
export class Input {
  constructor(canvas, actions) {
    this.canvas = canvas;
    this.actions = actions;
    this.enabled = false; // gameplay keys only while playing
    this.keys = 0;
    this.mouseButtons = 0;
    this.mouseX = innerWidth / 2;
    this.mouseY = innerHeight / 2;
    this.aimWithMouse = false;
    this.touchMode = false;
    this.stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
    this.fireTouch = -1;
    this.touchHeld = new Map(); // pointer id -> Button bit, for fingers on on-screen buttons
    this.lockPressed = false; // orbit lock toggles once per press, so it rides on exactly one command
    // Output of sample()
    this.buttons = 0;
    this.aim = 0;

    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.releaseAll());
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    addEventListener('pointermove', (e) => this.onPointerMove(e));
    addEventListener('pointerup', (e) => this.onPointerUp(e));
    addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll() {
    this.keys = 0;
    this.mouseButtons = 0;
    this.stick.id = -1;
    this.fireTouch = -1;
    this.touchHeld.clear();
    this.lockPressed = false;
  }

  onKey(e, down) {
    if (e.target instanceof HTMLInputElement) return; // typing a name
    const bit = KEY_BUTTONS[e.code];
    if (bit !== undefined) {
      if (this.enabled) e.preventDefault();
      if (down) {
        this.keys |= bit;
        if (bit === Button.LEFT || bit === Button.RIGHT) this.aimWithMouse = false;
      } else {
        this.keys &= ~bit;
      }
      return;
    }
    if (!down || e.repeat) return;
    if (e.code === 'KeyL') {
      if (this.enabled) this.lockPressed = true;
    } else if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 8) this.actions.upgrade(n - 1);
    } else if (e.code in WEAPON_KEYS) {
      this.actions.weapon(WEAPON_KEYS[e.code]);
    } else if (e.code === 'Enter') {
      this.actions.respawn();
    } else if (e.code === 'KeyM') {
      this.actions.toggleMute();
    } else if (e.code === 'KeyI') {
      this.actions.toggleStealth();
    } else if (e.code === 'F3' || e.code === 'Backquote') {
      e.preventDefault();
      this.actions.toggleDebug();
    }
  }

  onPointerDown(e) {
    if (e.pointerType === 'touch') {
      this.touchMode = true;
      const action = this.actions.hudPress(e.clientX, e.clientY);
      if (action) {
        if (action.type in TOUCH_HOLD) this.touchHeld.set(e.pointerId, TOUCH_HOLD[action.type]);
        else if (action.type === 'lock') this.lockPressed = true;
        return;
      }
      if (e.clientX < innerWidth / 2 && this.stick.id === -1) {
        this.stick.id = e.pointerId;
        this.stick.ox = this.stick.x = e.clientX;
        this.stick.oy = this.stick.y = e.clientY;
      } else if (this.fireTouch === -1) {
        this.fireTouch = e.pointerId;
      }
      return;
    }
    this.touchMode = false;
    if (e.button === 0 && this.actions.hudPress(e.clientX, e.clientY)) return;
    if (e.button === 0) this.mouseButtons |= Button.FIRE;
    if (e.button === 2) this.mouseButtons |= Button.THRUST;
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  onPointerMove(e) {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.stick.id) {
        this.stick.x = e.clientX;
        this.stick.y = e.clientY;
      }
      return;
    }
    if (Math.abs(e.clientX - this.mouseX) + Math.abs(e.clientY - this.mouseY) > 2) this.aimWithMouse = true;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  }

  onPointerUp(e) {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.stick.id) this.stick.id = -1;
      if (e.pointerId === this.fireTouch) this.fireTouch = -1;
      this.touchHeld.delete(e.pointerId);
      return;
    }
    if (e.button === 0) this.mouseButtons &= ~Button.FIRE;
    if (e.button === 2) this.mouseButtons &= ~Button.THRUST;
  }

  /** Touch-stick displacement in px, or null when the stick is idle. */
  stickVector() {
    if (this.stick.id === -1) return null;
    return { dx: this.stick.x - this.stick.ox, dy: this.stick.y - this.stick.oy };
  }

  /**
   * Computes `buttons` and `aim` for this tick. (shipX, shipY) is the player's
   * ship position on screen in CSS pixels; `angle` its current heading.
   */
  sample(shipX, shipY, angle) {
    let buttons = this.keys | this.mouseButtons;
    let aim = angle;
    const stick = this.stickVector();
    if (stick) {
      const len = Math.hypot(stick.dx, stick.dy);
      if (len > STICK_DEADZONE) {
        aim = Math.atan2(stick.dy, stick.dx);
        buttons |= Button.AIM | Button.THRUST;
        if (len > STICK_BOOST) buttons |= Button.BOOST;
      }
    } else if (this.aimWithMouse && !this.touchMode) {
      aim = Math.atan2(this.mouseY - shipY, this.mouseX - shipX);
      if ((buttons & (Button.LEFT | Button.RIGHT)) === 0) buttons |= Button.AIM;
    }
    if (this.fireTouch !== -1) buttons |= Button.FIRE;
    for (const bit of this.touchHeld.values()) buttons |= bit;
    if (this.lockPressed) {
      buttons |= Button.LOCK;
      this.lockPressed = false;
    }
    this.buttons = buttons;
    this.aim = aim;
  }
}
